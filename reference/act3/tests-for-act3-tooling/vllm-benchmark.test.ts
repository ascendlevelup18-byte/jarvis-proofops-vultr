// Opt-in vLLM benchmark mode, driven against the fake OpenAI-compatible server with a
// scripted fixture-like model. This verifies the runner's plumbing and output handling;
// the numbers it produces are NOT real-model or AMD measurements.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadAiConfig } from "../src/ai-config.ts";
import { AiStartupError } from "../src/ai-mode.ts";
import { loadDataset } from "../eval/dataset.ts";
import { runVllmBenchmark, type VllmBenchmarkReport } from "../eval/vllm-benchmark.ts";
import { fixtureLikeAnswer } from "./fake-jarvis-model.ts";
import { startFakeOpenAIServer, type FakeOpenAIServer } from "./fake-openai-server.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DATASET = `${ROOT}data/cases/duplicate-charge-eval.v1.json`;
const FIXTURE_RESULTS = `${ROOT}evals/results/duplicate-charge-eval.v1.json`;
const SECRET = "sk-bench-SECRET-77";

describe("vLLM benchmark mode (fake server; not a real-model measurement)", () => {
  let fake: FakeOpenAIServer;
  let outDir: string;
  const env = () => ({
    JARVIS_AI_MODE: "vllm",
    JARVIS_MODEL_BASE_URL: fake.baseUrl,
    JARVIS_MODEL_NAME: "fake/model-7B",
    JARVIS_MODEL_API_KEY: SECRET,
    JARVIS_MODEL_TIMEOUT_MS: "3000",
  });

  before(async () => {
    fake = await startFakeOpenAIServer();
    fake.setModelsScenario({ kind: "list", ids: ["fake/model-7B"] });
    fake.setScenario({ kind: "respond", respond: fixtureLikeAnswer });
    outDir = mkdtempSync(join(tmpdir(), "jarvis-bench-"));
  });
  after(async () => {
    await fake.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  test("writes a separate, labelled real-model-mode report with run metadata and telemetry", async () => {
    const fixtureBefore = readFileSync(FIXTURE_RESULTS, "utf8");
    const { report, outPath } = await runVllmBenchmark({
      config: loadAiConfig(env()),
      loaded: loadDataset(DATASET),
      outDir,
      runId: "t1",
    });
    assert.equal(outPath, join(outDir, "duplicate-charge-eval.v1.vllm-fake-model-7b-t1.json"));
    const onDisk = JSON.parse(readFileSync(outPath, "utf8")) as VllmBenchmarkReport;
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(report)));

    const b = report.benchmark;
    assert.equal(b.mode, "vllm");
    assert.equal(b.model, "vllm:fake/model-7B");
    assert.equal(b.run.runId, "t1");
    assert.match(b.run.gitSha, /^[0-9a-f]{40}$|^unknown$/);
    assert.equal(b.run.endpoint, fake.baseUrl);
    assert.equal(b.run.structuredOutput, "json_schema");
    assert.equal(b.run.engineTimeoutMs, 3000);
    assert.match(b.run.promptVersions.decision, /^[0-9a-f]{64}$/);
    assert.equal(b.datasetSha256, "d5a8b4064b81bf8bfd69f95e8e0b6aa081529d63b053287a2761d3f4c9c28e47");
    assert.ok(b.run.scriptedModelCases.length > 0, "dataset raw-output cases are listed as scripted");

    // The scripted fake model answers like the fixtures, so the engine outcome must match.
    assert.equal(report.metrics.unsafeAutonomousActions, 0);
    assert.equal(report.metrics.passed, 29);
    const t = report.telemetry;
    assert.equal(t.parseFailures, 0);
    assert.equal(t.providerErrors, 0);
    assert.equal(t.timeouts, 0);
    assert.ok(t.latencyMs.UNDERSTANDING.count >= 30);
    assert.ok(t.latencyMs.UNDERSTANDING.p50 !== null && t.latencyMs.UNDERSTANDING.p95 !== null);

    const text = readFileSync(outPath, "utf8");
    assert.ok(!text.includes(SECRET), "API key in results");
    assert.ok(!text.includes("charged twice"), "customer text in results");
    assert.equal(readFileSync(FIXTURE_RESULTS, "utf8"), fixtureBefore, "fixture results must not change");
  });

  test("two-model run: own results file, both models recorded, same safety outcome", async () => {
    fake.setModelsScenario({ kind: "list", ids: ["fake/model-7B", "gemma-fake"] });
    try {
      const { report, outPath } = await runVllmBenchmark({
        config: loadAiConfig({ ...env(), JARVIS_UNDERSTANDING_MODEL_NAME: "gemma-fake" }),
        loaded: loadDataset(DATASET),
        outDir,
        runId: "g1",
      });
      assert.equal(outPath, join(outDir, "duplicate-charge-eval.v1.vllm-gemma-fake-fake-model-7b-g1.json"));
      assert.deepEqual(report.benchmark.run.models, { understanding: "gemma-fake", decision: "fake/model-7B" });
      assert.equal(report.benchmark.model, "vllm:fake/model-7B");
      assert.equal(report.metrics.unsafeAutonomousActions, 0);
      assert.equal(report.metrics.passed, 29);
    } finally {
      fake.setModelsScenario({ kind: "list", ids: ["fake/model-7B"] });
    }
  });

  test("counts decision parse failures; they fail closed (no unsafe action)", async () => {
    // Passes the startup probe, then answers every real case's decision with non-JSON.
    fake.setScenario({
      kind: "respond",
      respond: async (body) => {
        const answer = await fixtureLikeAnswer(body);
        const isProbe = JSON.stringify(body).includes("PROBE-1");
        return answer.includes('"intent"') || isProbe ? answer : "not json";
      },
    });
    try {
      const { report } = await runVllmBenchmark({ config: loadAiConfig(env()), loaded: loadDataset(DATASET), outDir, runId: "t2" });
      assert.equal(report.metrics.unsafeAutonomousActions, 0);
      assert.ok(report.telemetry.parseFailures > 0);
      assert.equal(report.telemetry.parseFailuresByStage.MODEL, report.telemetry.parseFailures);
      assert.equal(report.telemetry.providerErrors, 0);
    } finally {
      fake.setScenario({ kind: "respond", respond: fixtureLikeAnswer });
    }
  });

  test("unreachable endpoint fails closed before running or writing anything", async () => {
    const dead = await startFakeOpenAIServer();
    const config = loadAiConfig({ ...env(), JARVIS_MODEL_BASE_URL: dead.baseUrl });
    await dead.close();
    const before = readdirSync(outDir).length;
    await assert.rejects(
      runVllmBenchmark({ config, loaded: loadDataset(DATASET), outDir, runId: "t3" }),
      (e: unknown) => e instanceof AiStartupError && e.stage === "MODEL_LIST",
    );
    assert.equal(readdirSync(outDir).length, before);
  });

  test("refuses fixture config and never overwrites an earlier run", async () => {
    await assert.rejects(
      runVllmBenchmark({ config: loadAiConfig({}), loaded: loadDataset(DATASET), outDir, runId: "t4" }),
      /JARVIS_AI_MODE=vllm/,
    );
    writeFileSync(join(outDir, "duplicate-charge-eval.v1.vllm-fake-model-7b-t5.json"), "{}");
    await assert.rejects(
      runVllmBenchmark({ config: loadAiConfig(env()), loaded: loadDataset(DATASET), outDir, runId: "t5" }),
      /already exists/,
    );
    await assert.rejects(runVllmBenchmark({ config: loadAiConfig(env()), loaded: loadDataset(DATASET), outDir, runId: "../x" }), /run id/);
  });

  test("CLI: --mode vllm requires vllm config; --ci stays fixture-only; a healthy run exits 0", async () => {
    const cli = (args: string[], extraEnv: Record<string, string>) => runCli(args, extraEnv);
    const noConfig = await cli(["--mode", "vllm", "--out-dir", outDir], {});
    assert.equal(noConfig.code, 1);
    assert.match(noConfig.stderr, /JARVIS_AI_MODE=vllm/);

    const ci = await cli(["--ci", "--mode", "vllm", "--out-dir", outDir], env());
    assert.equal(ci.code, 1);
    assert.match(ci.stderr, /--ci is fixture-only/);

    const ok = await cli(["--mode", "vllm", "--run", "cli1", "--out-dir", outDir], env());
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /mode: vllm/);
    assert.match(ok.stdout, /VLLM GATE PASSED: 0 unsafe autonomous actions/);
    assert.ok(existsSync(join(outDir, "duplicate-charge-eval.v1.vllm-fake-model-7b-cli1.json")));
    assert.ok(!(ok.stdout + ok.stderr).includes(SECRET));
  });
});

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = fileURLToPath(new URL("../eval/run-benchmark.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`benchmark CLI timed out\n${stdout}\n${stderr}`));
    }, 60_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}
