// G3: AI mode composition and fail-closed vLLM startup (§G row 24 and §L step 4).
// Everything here runs against the local fake OpenAI-compatible server: it verifies
// startup plumbing, NOT real model inference.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadAiConfig, sanitizeEndpoint, type AiConfig } from "../src/ai-config.ts";
import { AiStartupError, buildAiAdapters, initializeAi, type ModelCallLog } from "../src/ai-mode.ts";
import { runCase } from "../src/case-engine.ts";
import { SCENARIOS } from "../src/fixtures.ts";
import { FixtureModelAdapter, VllmModelAdapter } from "../src/model-adapter.ts";
import { FixtureRequestUnderstandingAdapter, VllmRequestUnderstandingAdapter } from "../src/request-understanding.ts";
import { fixtureLikeAnswer } from "./fake-jarvis-model.ts";
import { startFakeOpenAIServer, type FakeOpenAIServer } from "./fake-openai-server.ts";
import { makeDeps, proposal } from "./helpers.ts";

const SECRET = "sk-test-SECRET-4f9a";
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const vllmEnv = (fake: FakeOpenAIServer, extra: Record<string, string> = {}) => ({
  JARVIS_AI_MODE: "vllm",
  JARVIS_MODEL_BASE_URL: fake.baseUrl,
  JARVIS_MODEL_NAME: "fake-model",
  JARVIS_MODEL_API_KEY: SECRET,
  JARVIS_MODEL_TIMEOUT_MS: "2000",
  JARVIS_DAILY_MODEL_CALL_BUDGET: "100",
  ...extra,
});
const vllmConfig = (fake: FakeOpenAIServer, extra: Record<string, string> = {}): AiConfig => loadAiConfig(vllmEnv(fake, extra));

async function rejectsAt(p: Promise<unknown>, stage: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AiStartupError, `expected AiStartupError, got ${String(e)}`);
    assert.equal(e.stage, stage, e.message);
    if (pattern) assert.match(e.message, pattern);
    assert.ok(!e.message.includes(SECRET), "API key leaked into the startup error");
    return true;
  });
}

describe("AI startup (fake OpenAI-compatible server; not real inference)", () => {
  let fake: FakeOpenAIServer;
  before(async () => {
    fake = await startFakeOpenAIServer();
  });
  after(async () => {
    await fake.close();
  });
  const healthy = () => {
    fake.setModelsScenario({ kind: "list", ids: ["other-model", "fake-model"] });
    fake.setScenario({ kind: "respond", respond: fixtureLikeAnswer });
  };

  test("1: fixture mode starts without an endpoint and keeps fixture adapters + 10s timeout", async () => {
    const { runtime, startup } = await initializeAi(loadAiConfig({}));
    assert.equal(runtime.mode, "fixture");
    assert.ok(runtime.understanding instanceof FixtureRequestUnderstandingAdapter);
    assert.ok(runtime.model instanceof FixtureModelAdapter);
    assert.equal(runtime.engineTimeoutMs, 10_000);
    assert.equal(startup.mode, "fixture");
    assert.equal(startup.modelListed, null);
  });

  test("buildAiAdapters(vllm) never constructs fixture adapters", () => {
    const runtime = buildAiAdapters(vllmConfig(fake));
    assert.ok(runtime.understanding instanceof VllmRequestUnderstandingAdapter);
    assert.ok(runtime.model instanceof VllmModelAdapter);
    assert.equal(runtime.understanding.id, "vllm:fake-model");
    assert.equal(runtime.model.id, "vllm:fake-model");
    assert.equal(runtime.engineTimeoutMs, 2000); // K2: engine uses the configured timeout
  });

  test("2: vllm with missing configuration fails before any network call", () => {
    assert.throws(() => loadAiConfig({ JARVIS_AI_MODE: "vllm", JARVIS_MODEL_NAME: "m" }), /JARVIS_MODEL_BASE_URL/);
    assert.throws(() => loadAiConfig({ JARVIS_AI_MODE: "vllm", JARVIS_MODEL_BASE_URL: "http://h/v1" }), /JARVIS_MODEL_NAME/);
    assert.throws(
      () => loadAiConfig({ JARVIS_AI_MODE: "vllm", JARVIS_MODEL_BASE_URL: "http://h/v1", JARVIS_MODEL_NAME: "m", JARVIS_MODEL_STRUCTURED_OUTPUT: "maybe" }),
      /JARVIS_MODEL_STRUCTURED_OUTPUT/,
    );
  });

  test("3: unreachable endpoint fails at MODEL_LIST", async () => {
    const dead = await startFakeOpenAIServer();
    const cfg = vllmConfig(dead);
    await dead.close();
    await rejectsAt(initializeAi(cfg), "MODEL_LIST", /connection failed/);
  });

  test("model list HTTP 401 echoing the key fails at MODEL_LIST without disclosing the key", async () => {
    fake.setModelsScenario({ kind: "http_status", status: 401 });
    await rejectsAt(initializeAi(vllmConfig(fake)), "MODEL_LIST", /HTTP 401/);
  });

  test("4: model list without the configured model fails at MODEL_NOT_SERVED", async () => {
    healthy();
    fake.setModelsScenario({ kind: "list", ids: ["some-other-model"] });
    await rejectsAt(initializeAi(vllmConfig(fake)), "MODEL_NOT_SERVED", /"fake-model" is not served/);
  });

  test("malformed model list fails at MODEL_LIST", async () => {
    fake.setModelsScenario({ kind: "unexpected_shape", body: { object: "list" } });
    await rejectsAt(initializeAi(vllmConfig(fake)), "MODEL_LIST", /data\[\]/);
  });

  test("5 + 7: listed model and valid probes start vLLM mode; report is safe", async () => {
    healthy();
    const calls: ModelCallLog[] = [];
    const { runtime, startup } = await initializeAi(vllmConfig(fake), { onCall: (e) => calls.push(e) });
    assert.equal(runtime.mode, "vllm");
    assert.ok(runtime.model instanceof VllmModelAdapter);
    assert.equal(startup.modelListed, true);
    assert.deepEqual(startup.probes, { understanding: "ok", decision: "ok" });
    assert.equal(startup.structuredOutput, "json_schema");
    assert.equal(startup.endpoint, fake.baseUrl);
    assert.match(startup.promptVersions.understanding, /^[0-9a-f]{64}$/);
    assert.match(startup.promptVersions.decision, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(startup).includes(SECRET));

    // One log line per probe call, operational metadata only.
    assert.deepEqual(calls.map((c) => [c.stage, c.model, c.finishReason, c.failureCategory]), [
      ["UNDERSTANDING", "fake-model", "stop", null],
      ["MODEL", "fake-model", "stop", null],
    ]);
    const logged = JSON.stringify(calls);
    assert.ok(!logged.includes("untrusted") && !logged.includes("POLICY") && !logged.includes(SECRET));

    // The started runtime serves a real case through the vLLM adapters.
    const deps = makeDeps({ understanding: runtime.understanding, model: runtime.model, modelTimeoutMs: runtime.engineTimeoutMs });
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assert.equal(c.state, "RESOLVED");
  });

  test("probe sends response_format when json_schema is configured, and none when off", async () => {
    healthy();
    await initializeAi(vllmConfig(fake));
    assert.equal((fake.lastRequestBody as { response_format?: { type: string } }).response_format?.type, "json_schema");
    const { startup } = await initializeAi(vllmConfig(fake, { JARVIS_MODEL_STRUCTURED_OUTPUT: "off" }));
    assert.equal(startup.structuredOutput, "off");
    assert.equal((fake.lastRequestBody as { response_format?: unknown }).response_format, undefined);
  });

  test("6: invalid understanding probe output prevents startup", async () => {
    healthy();
    fake.setScenario({ kind: "text_around_json", content: 'Sure: {"intent":"UNKNOWN","mentionedAmounts":[]}' });
    await rejectsAt(initializeAi(vllmConfig(fake)), "PROBE_UNDERSTANDING", /schema/);
  });

  test("6: invalid decision probe output prevents startup", async () => {
    healthy();
    fake.setScenario({
      kind: "respond",
      respond: async (body) => {
        const answer = await fixtureLikeAnswer(body);
        return answer.includes('"intent"') ? answer : proposal({ verified: true });
      },
    });
    await rejectsAt(initializeAi(vllmConfig(fake)), "PROBE_DECISION", /verified|Unrecognized/);
  });

  test("6: refusal, truncation and 5xx during the probe prevent startup", async () => {
    healthy();
    fake.setScenario({ kind: "unexpected_shape", body: { choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }] } });
    await rejectsAt(initializeAi(vllmConfig(fake)), "PROBE_UNDERSTANDING", /content is not a string/);
    fake.setScenario({ kind: "ok", content: '{"intent":"UNK', finishReason: "length" });
    await rejectsAt(initializeAi(vllmConfig(fake)), "PROBE_UNDERSTANDING", /finish_reason=length/);
    fake.setScenario({ kind: "http_status", status: 503, body: `{"error":"overloaded; key=${SECRET}"}` });
    await rejectsAt(initializeAi(vllmConfig(fake)), "PROBE_UNDERSTANDING", /HTTP 503/);
  });

  test("8: a provider failing after startup fails cases; never a fixture answer", async () => {
    healthy();
    const { runtime } = await initializeAi(vllmConfig(fake));
    fake.setScenario({ kind: "http_status", status: 500 });
    const deps = makeDeps({ understanding: runtime.understanding, model: runtime.model, modelTimeoutMs: runtime.engineTimeoutMs });
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "UNDERSTANDING_ERROR");
    assert.equal(c.understanding, null);
  });

  test("10: engine timeout from the configured value classifies as *_TIMEOUT (K2)", async () => {
    healthy();
    const { runtime } = await initializeAi(vllmConfig(fake, { JARVIS_MODEL_TIMEOUT_MS: "300" }));
    fake.setScenario({ kind: "hang" });
    const deps = makeDeps({ understanding: runtime.understanding, model: runtime.model, modelTimeoutMs: runtime.engineTimeoutMs });
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "UNDERSTANDING_TIMEOUT");
  });

  test("retries: transient 503 during a case is retried once; call log records attempts and usage", async () => {
    healthy();
    const calls: ModelCallLog[] = [];
    const { runtime } = await initializeAi(vllmConfig(fake, { JARVIS_MODEL_MAX_RETRIES: "1" }), { onCall: (e) => calls.push(e) });
    assert.equal(runtime.modelCallsPerCase, 4);
    fake.setScenario({
      kind: "sequence",
      steps: [{ kind: "http_status", status: 503 }, { kind: "respond", respond: fixtureLikeAnswer }],
    });
    const deps = makeDeps({ understanding: runtime.understanding, model: runtime.model, modelTimeoutMs: runtime.engineTimeoutMs });
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assert.equal(c.state, "RESOLVED");
    const caseCalls = calls.slice(2); // after the two startup probes
    assert.equal(caseCalls[0]?.attempts, 2);
    assert.equal(caseCalls[0]?.promptTokens, 11);
    assert.equal(caseCalls[0]?.completionTokens, 7);
  });

  test("retries: a persistent 401 is never retried and fails the case before any action", async () => {
    healthy();
    const { runtime } = await initializeAi(vllmConfig(fake, { JARVIS_MODEL_MAX_RETRIES: "2" }));
    fake.setScenario({ kind: "http_status", status: 401 });
    const before = fake.requestCount;
    const deps = makeDeps({ understanding: runtime.understanding, model: runtime.model, modelTimeoutMs: runtime.engineTimeoutMs });
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "UNDERSTANDING_ERROR");
    assert.equal(c.action, null);
    assert.equal(fake.requestCount - before, 1);
  });

  test("JARVIS_MODEL_MAX_RETRIES is validated (0..3)", () => {
    assert.throws(() => vllmConfig(fake, { JARVIS_MODEL_MAX_RETRIES: "5" }), /JARVIS_MODEL_MAX_RETRIES/);
    assert.equal(loadAiConfig({}).modelMaxRetries, 0);
  });

  test("9: endpoint is logged without credentials, query or fragment", () => {
    assert.equal(sanitizeEndpoint("https://user:pa55@gpu.example.com:8000/v1?token=abc#x"), "https://gpu.example.com:8000/v1");
    assert.equal(sanitizeEndpoint("not a url"), "[invalid url]");
  });

  // ---------- main.ts as a process ----------

  test("main: vllm with an unserved model exits 1, never serves, never leaks the key", async () => {
    fake.setModelsScenario({ kind: "list", ids: ["some-other-model"] });
    const r = await runMain({ ...vllmEnv(fake), PORT: String(await freePort()) }, { untilExit: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /MODEL_NOT_SERVED/);
    assert.doesNotMatch(r.stdout, /listening/);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  });

  test("main: vllm without an explicit daily model-call budget exits 1 before calling the endpoint", async () => {
    healthy();
    const env: Record<string, string> = { ...vllmEnv(fake), PORT: String(await freePort()) };
    delete env.JARVIS_DAILY_MODEL_CALL_BUDGET;
    const r = await runMain(env, { untilExit: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /JARVIS_DAILY_MODEL_CALL_BUDGET/);
    assert.doesNotMatch(r.stdout, /model call/);
  });

  test("main: vllm with a healthy endpoint serves cases through the vLLM adapters", async () => {
    healthy();
    const port = await freePort();
    const r = await runMain({ ...vllmEnv(fake), PORT: String(port) }, {
      onListening: async () => {
        const res = await fetch(`http://127.0.0.1:${port}/cases`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(SCENARIOS.validDuplicate),
        });
        const body = (await res.json()) as { state: string; audit: { type: string; data: { adapter?: string } }[] };
        assert.equal(body.state, "RESOLVED");
        assert.ok(body.audit.some((e) => e.type === "MODEL_CALL" && e.data.adapter === "vllm:fake-model"));
      },
    });
    assert.match(r.stdout, /"probes":\{"understanding":"ok","decision":"ok"\}/);
    assert.match(r.stdout, /listening/);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET));
    assert.ok(!r.stdout.includes("charged twice"), "customer text must not be logged");
  });

  test("main: fixture mode still starts without an endpoint", async () => {
    const port = await freePort();
    const r = await runMain({ JARVIS_AI_MODE: "fixture", PORT: String(port) }, { onListening: async () => {} });
    assert.match(r.stdout, /"mode":"fixture"/);
    assert.match(r.stdout, /listening/);
  });

  // ---------- demo:verify --real-model (proof the cases ran on the remote model) ----------

  test("demo:verify --real-model passes on vllm adapters and writes non-secret evidence", async () => {
    healthy();
    const port = await freePort();
    const file = join(mkdtempSync(join(tmpdir(), "jarvis-evidence-")), "evidence.json");
    let v: { code: number | null; stdout: string } = { code: null, stdout: "" };
    await runMain({ ...vllmEnv(fake), PORT: String(port) }, {
      onListening: async () => {
        v = await runVerify(["--real-model", `http://127.0.0.1:${port}`, "--evidence", file]);
      },
    });
    assert.equal(v.code, 0, v.stdout);
    assert.match(v.stdout, /PASS {2}8 Real model: health reports vllm mode/);
    const evidence = readFileSync(file, "utf8");
    assert.ok(!evidence.includes(SECRET), "API key leaked into the evidence file");
    const parsed = JSON.parse(evidence) as { health: { aiMode: string }; cases: { orderId: string; aiCalls: { adapter: string }[] }[] };
    assert.equal(parsed.health.aiMode, "vllm");
    assert.deepEqual(parsed.cases.map((c) => c.orderId), ["48291", "48294", "48293", "48292"]);
    assert.ok(parsed.cases.every((c) => c.aiCalls.length > 0 && c.aiCalls.every((a) => a.adapter === "vllm:fake-model")));
  });

  test("demo:verify --real-model fails against fixture mode (no silent fixture proof)", async () => {
    const port = await freePort();
    const file = join(mkdtempSync(join(tmpdir(), "jarvis-evidence-")), "evidence.json");
    let v: { code: number | null; stdout: string } = { code: null, stdout: "" };
    await runMain({ JARVIS_AI_MODE: "fixture", PORT: String(port) }, {
      onListening: async () => {
        v = await runVerify(["--real-model", `http://127.0.0.1:${port}`, "--evidence", file]);
      },
    });
    assert.equal(v.code, 1);
    assert.match(v.stdout, /FAIL {2}8 Real model: health reports vllm mode/);
    assert.match(v.stdout, /FAIL {4}#48291 AI calls used the remote model/);
  });

  // ---------- two models: separate understanding model (e.g. Gemma) on the same endpoint ----------

  const twoModels = { JARVIS_UNDERSTANDING_MODEL_NAME: "gemma-fake" };
  const servesBoth = () => {
    healthy();
    fake.setModelsScenario({ kind: "list", ids: ["fake-model", "gemma-fake"] });
  };

  test("two models: understanding runs on its own model, decision keeps the main model; each call is attributed", async () => {
    servesBoth();
    const seen: { model: string; format: string | null }[] = [];
    fake.setScenario({
      kind: "respond",
      respond: (body) => {
        const b = body as { model: string; response_format?: { type: string } };
        seen.push({ model: b.model, format: b.response_format?.type ?? null });
        return fixtureLikeAnswer(body);
      },
    });
    const calls: ModelCallLog[] = [];
    const config = vllmConfig(fake, { ...twoModels, JARVIS_UNDERSTANDING_STRUCTURED_OUTPUT: "json_object" });
    const { runtime, startup } = await initializeAi(config, { onCall: (e) => calls.push(e) });
    assert.equal(runtime.understanding.id, "vllm:gemma-fake");
    assert.equal(runtime.model.id, "vllm:fake-model");
    assert.equal(startup.understandingModel, "gemma-fake");
    assert.equal(startup.model, "fake-model");
    assert.equal(startup.understandingStructuredOutput, "json_object");
    assert.equal(startup.structuredOutput, "json_schema");
    assert.deepEqual(calls.map((c) => [c.stage, c.model]), [["UNDERSTANDING", "gemma-fake"], ["MODEL", "fake-model"]]);
    // The request bodies name the right model and each stage's own response_format.
    assert.deepEqual(seen, [{ model: "gemma-fake", format: "json_object" }, { model: "fake-model", format: "json_schema" }]);

    const deps = makeDeps({ understanding: runtime.understanding, model: runtime.model, modelTimeoutMs: runtime.engineTimeoutMs });
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assert.equal(c.state, "RESOLVED");
    const adapterOf = (type: string) => c.audit.find((e) => e.type === type)?.data as { adapter?: string } | undefined;
    assert.equal(adapterOf("UNDERSTANDING_CALL")?.adapter, "vllm:gemma-fake");
    assert.equal(adapterOf("MODEL_CALL")?.adapter, "vllm:fake-model");
  });

  test("two models: the safety outcomes are unchanged (conflicting amount escalates, already-refunded closes)", async () => {
    servesBoth();
    const { runtime } = await initializeAi(vllmConfig(fake, twoModels));
    const deps = () => makeDeps({ understanding: runtime.understanding, model: runtime.model, modelTimeoutMs: runtime.engineTimeoutMs });
    const conflicting = await runCase(SCENARIOS.conflictingAmount, deps());
    assert.equal(conflicting.state, "ESCALATED");
    assert.equal(conflicting.action, null);
    const refunded = await runCase(SCENARIOS.alreadyRefunded, deps());
    assert.equal(refunded.state, "CLOSED_NO_ACTION");
    assert.equal(refunded.action, null);
  });

  test("two models: an unserved understanding model stops startup (no fallback to the decision model)", async () => {
    healthy();
    fake.setModelsScenario({ kind: "list", ids: ["fake-model"] });
    await rejectsAt(initializeAi(vllmConfig(fake, twoModels)), "MODEL_NOT_SERVED", /"gemma-fake" is not served/);
  });

  test("two models: invalid understanding output from the second model prevents startup", async () => {
    servesBoth();
    fake.setScenario({ kind: "ok", content: '{"intent":"NOT_AN_INTENT"}' });
    await rejectsAt(initializeAi(vllmConfig(fake, twoModels)), "PROBE_UNDERSTANDING", /schema/);
  });

  test("AMD-only mode is unaffected when the endpoint stops listing the optional understanding model", async () => {
    healthy();
    fake.setModelsScenario({ kind: "list", ids: ["fake-model"] }); // e.g. Gemma withdrawn from the catalogue
    const { runtime, startup } = await initializeAi(vllmConfig(fake));
    assert.equal(startup.modelListed, true);
    assert.equal(runtime.understanding.id, "vllm:fake-model");
    const c = await runCase(SCENARIOS.validDuplicate, makeDeps({ understanding: runtime.understanding, model: runtime.model, modelTimeoutMs: runtime.engineTimeoutMs }));
    assert.equal(c.state, "RESOLVED");
  });

  test("one model by default: understanding and decision share the configured model", async () => {
    healthy();
    const { runtime, startup } = await initializeAi(vllmConfig(fake));
    assert.equal(runtime.understanding.id, "vllm:fake-model");
    assert.equal(startup.understandingModel, "fake-model");
  });

  test("demo:verify --real-model with two models checks per-stage attribution and records both models", async () => {
    servesBoth();
    const port = await freePort();
    const file = join(mkdtempSync(join(tmpdir(), "jarvis-evidence-")), "evidence.json");
    let v: { code: number | null; stdout: string } = { code: null, stdout: "" };
    await runMain({ ...vllmEnv(fake, twoModels), PORT: String(port) }, {
      onListening: async () => {
        v = await runVerify(["--real-model", `http://127.0.0.1:${port}`, "--evidence", file]);
      },
    });
    assert.equal(v.code, 0, v.stdout);
    assert.match(v.stdout, /PASS {4}#48291 each stage used its configured model/);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      health: { models: { understanding: string; decision: string } };
      cases: { aiCalls: { type: string; adapter: string }[] }[];
    };
    assert.deepEqual(parsed.health.models, { understanding: "gemma-fake", decision: "fake-model" });
    for (const c of parsed.cases) {
      assert.ok(c.aiCalls.filter((a) => a.type === "UNDERSTANDING_CALL").every((a) => a.adapter === "vllm:gemma-fake"));
      assert.ok(c.aiCalls.filter((a) => a.type === "MODEL_CALL").every((a) => a.adapter === "vllm:fake-model"));
    }
  });
});

const VERIFY = fileURLToPath(new URL("../../../scripts/verify-demo.mjs", import.meta.url));

function runVerify(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VERIFY, ...args], { env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout }));
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

// Runs main.ts with a clean env. Either waits for exit, or waits for the listening
// line, runs a check, then stops the process. Always bounded by a hard timeout.
function runMain(
  env: Record<string, string>,
  opts: { untilExit?: boolean; onListening?: () => Promise<void> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let checking = false;
    let checkError: unknown = null;
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`main did not finish in time\nstdout:${stdout}\nstderr:${stderr}`));
    }, 15_000);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (!opts.untilExit && !checking && /listening/.test(stdout)) {
        checking = true;
        opts.onListening!()
          .catch((e: unknown) => {
            checkError = e;
          })
          .finally(() => child.kill("SIGTERM"));
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(killer);
      if (checkError) reject(checkError as Error);
      else resolve({ code, stdout, stderr });
    });
  });
}
