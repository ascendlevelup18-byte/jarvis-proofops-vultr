// End to end through every ingress: the node:http server over real HTTP, and the
// Netlify and Vercel serverless wrappers (Web Request → Response, called directly).
// vLLM-mode cases use the local fake OpenAI-compatible server: plumbing only, not AMD.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import netlifyCases from "../../../netlify/functions/cases.ts";
import netlifyHealth from "../../../netlify/functions/health.ts";
import { POST as vercelCases, GET as vercelCasesGet } from "../../../api/cases.ts";
import { GET as vercelHealth } from "../../../api/health.ts";
import type { Case, CaseRequest } from "../src/contracts.ts";
import { PUBLIC_DEMOS, type DemoId } from "../src/ingress.ts";
import { LocalInferenceLimiter } from "../src/limits.ts";
import { VllmModelAdapter } from "../src/model-adapter.ts";
import { OpenAICompatibleClient } from "../src/provider/index.ts";
import { VllmRequestUnderstandingAdapter } from "../src/request-understanding.ts";
import { createApp } from "../src/server.ts";
import { createServerlessHandlers } from "../src/serverless.ts";
import { fixtureLikeAnswer } from "./fake-jarvis-model.ts";
import { startFakeOpenAIServer, type FakeOpenAIServer } from "./fake-openai-server.ts";
import { ingressFor, makeDeps, TEST_TOKEN } from "./helpers.ts";

const EXPECTED: Record<DemoId, string> = {
  "valid-duplicate": "RESOLVED",
  "conflicting-amount": "ESCALATED",
  "already-refunded": "CLOSED_NO_ACTION",
  "prompt-injection": "ESCALATED",
};
const IDS = Object.keys(PUBLIC_DEMOS) as DemoId[];
const ORDERS = [IDS, [...IDS].reverse(), [IDS[2]!, IDS[0]!, IDS[3]!, IDS[1]!]];
const FREE_TEXT: CaseRequest = { customerId: "CUST-1001", orderId: "48291", message: "Hello, I was charged twice on order 48291, can you fix it?" };

type Post = (body: unknown, auth?: string) => Promise<Response>;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const httpPost = (base: string): Post => (body, auth) =>
  fetch(`${base}/cases`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
const webPost = (handler: (r: Request) => Promise<Response>): Post => (body, auth) =>
  handler(
    new Request("https://demo.example/cases", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    }),
  );

async function assertDemosRepeatable(post: Post): Promise<void> {
  const seen = new Set<string>();
  for (const order of ORDERS) {
    for (const id of order) {
      const res = await post(PUBLIC_DEMOS[id]);
      assert.equal(res.status, 200, id);
      assert.equal(res.headers.get("x-jarvis-payments"), "simulated");
      assert.equal(res.headers.get("x-jarvis-demo-scenario"), id);
      const c = (await res.json()) as Case;
      assert.equal(c.state, EXPECTED[id], `${id}: ${c.reasons.map((r) => r.code).join(",")}`);
      seen.add(res.headers.get("x-jarvis-demo-run")!);
    }
  }
  assert.equal(seen.size, ORDERS.length * IDS.length, "every demo run has its own id");
}

describe("node:http server ingress", () => {
  let server: Server;
  let post: Post;
  before(async () => {
    server = createApp(ingressFor(makeDeps()));
    post = httpPost(await listen(server));
  });
  after(() => server.close());

  test("four demos, repeated in three orders, give stable results", async () => {
    await assertDemosRepeatable(post);
  });

  test("free text: no token 401, wrong token 401, right token 200", async () => {
    assert.equal((await post(FREE_TEXT)).status, 401);
    const wrong = await post(FREE_TEXT, "Bearer not-the-right-token-123456");
    assert.equal(wrong.status, 401);
    assert.ok(!(await wrong.text()).includes(TEST_TOKEN));
    const ok = await post(FREE_TEXT, `Bearer ${TEST_TOKEN}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-jarvis-request-class"), "privileged");
  });

  test("over the rate limit: 429 with retry-after", async () => {
    const limited = createApp(ingressFor(makeDeps(), { limiter: new LocalInferenceLimiter({ maxConcurrent: 5, perClientPerMinute: 1, dailyModelCallBudget: 10 }) }));
    const p = httpPost(await listen(limited));
    try {
      assert.equal((await p(PUBLIC_DEMOS["valid-duplicate"])).status, 200);
      const r = await p(PUBLIC_DEMOS["valid-duplicate"]);
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get("retry-after")) > 0);
    } finally {
      limited.close();
    }
  });

  test("/api/health reports the configured runtime when provided, 404 otherwise", async () => {
    assert.equal((await fetch(`${httpBase(server)}/api/health`)).status, 404);
    const withHealth = createApp(ingressFor(makeDeps()), { health: () => ({ aiMode: "fixture" }) });
    const base = await listen(withHealth);
    try {
      assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { aiMode: "fixture" });
    } finally {
      withHealth.close();
    }
  });
});

const httpBase = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

describe("serverless ingress (Netlify + Vercel wrappers)", () => {
  const saved = { ...process.env };
  after(() => {
    process.env = saved;
  });

  for (const [name, handler] of [
    ["netlify", netlifyCases],
    ["vercel", vercelCases],
  ] as const) {
    test(`${name}: four demos repeat; free text is disabled without a configured token`, async () => {
      delete process.env.JARVIS_CASES_TOKEN;
      delete process.env.JARVIS_AI_MODE;
      const post = webPost(handler);
      await assertDemosRepeatable(post);
      const r = await post(FREE_TEXT, `Bearer ${TEST_TOKEN}`);
      assert.equal(r.status, 403);
      assert.equal(r.headers.get("x-jarvis-runtime"), `${name}-fixture-demo`);
    });
  }

  test("vercel: with a server-side token, free text needs it; GET /cases is 405", async () => {
    process.env.JARVIS_CASES_TOKEN = TEST_TOKEN;
    try {
      const post = webPost(vercelCases);
      assert.equal((await post(FREE_TEXT)).status, 401);
      assert.equal((await post(FREE_TEXT, "Bearer wrong-wrong-wrong-wrong-wrong")).status, 401);
      const ok = await post(FREE_TEXT, `Bearer ${TEST_TOKEN}`);
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as Case).state, "RESOLVED");
      // No shared state on serverless: the same privileged request resolves again in a fresh world.
      assert.equal(((await (await post(FREE_TEXT, `Bearer ${TEST_TOKEN}`)).json()) as Case).state, "RESOLVED");
      assert.equal((await vercelCasesGet(new Request("https://demo.example/cases"))).status, 405);
    } finally {
      delete process.env.JARVIS_CASES_TOKEN;
    }
  });

  test("a deployment configured for vllm refuses cases (503) instead of serving fixtures", async () => {
    const { cases, health } = createServerlessHandlers("vercel", { JARVIS_AI_MODE: "vllm" });
    const r = await webPost(cases)(PUBLIC_DEMOS["valid-duplicate"]);
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, "serverless_is_fixture_only");
    const h = (await (await health(new Request("https://demo.example/api/health"))).json()) as { ok: boolean; remoteModel: boolean };
    assert.equal(h.ok, false);
    assert.equal(h.remoteModel, false);
  });

  test("a weak token configuration refuses cases (503) rather than running unguarded", async () => {
    const { cases } = createServerlessHandlers("netlify", { JARVIS_CASES_TOKEN: "short" });
    const r = await webPost(cases)(PUBLIC_DEMOS["valid-duplicate"]);
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, "ingress_misconfigured");
  });

  test("health is honest on both hosts", async () => {
    for (const [name, h] of [
      ["netlify", await netlifyHealth(new Request("https://demo.example/api/health"))],
      ["vercel", await vercelHealth(new Request("https://demo.example/api/health"))],
    ] as const) {
      const body = (await h.json()) as Record<string, unknown>;
      assert.equal(body.deployment, name);
      assert.equal(body.aiMode, "fixture");
      assert.equal(body.remoteModel, false);
      assert.equal(body.paymentGateway, "simulated");
      assert.equal(body.limits, "per serverless instance, not global");
    }
  });
});

describe("vLLM-mode server ingress (fake model server; not AMD)", () => {
  let fake: FakeOpenAIServer;
  let calls = 0;
  before(async () => {
    fake = await startFakeOpenAIServer();
  });
  after(() => fake.close());

  const countingAnswer = async (body: unknown) => {
    calls++;
    return fixtureLikeAnswer(body);
  };
  async function vllmServer(budget: number) {
    const client = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "fake-model", timeoutMs: 3000 });
    const deps = makeDeps();
    const server = createApp(
      ingressFor(deps, {
        aiMode: "vllm",
        understanding: new VllmRequestUnderstandingAdapter(client),
        model: new VllmModelAdapter(client),
        engineTimeoutMs: 2000,
        limiter: new LocalInferenceLimiter({ maxConcurrent: 2, perClientPerMinute: 100, dailyModelCallBudget: budget }),
      }),
    );
    return { server, post: httpPost(await listen(server)) };
  }

  test("demos run through the vLLM adapters; over budget is 429 and never reaches the model", async () => {
    fake.setScenario({ kind: "respond", respond: countingAnswer });
    calls = 0;
    const { server, post } = await vllmServer(4);
    try {
      assert.equal(((await (await post(PUBLIC_DEMOS["valid-duplicate"])).json()) as Case).state, "RESOLVED");
      assert.equal(((await (await post(PUBLIC_DEMOS["prompt-injection"])).json()) as Case).state, "ESCALATED");
      assert.equal(calls, 4);
      const over = await post(PUBLIC_DEMOS["valid-duplicate"]);
      assert.equal(over.status, 429);
      assert.equal(((await over.json()) as { error: string }).error, "budget_exhausted");
      assert.equal(calls, 4, "a denied request reached the model");
      assert.equal((await post(FREE_TEXT)).status, 401);
      assert.equal(calls, 4);
    } finally {
      server.close();
    }
  });

  test("provider unavailable -> 200 with a FAILED case (no action), never RESOLVED", async () => {
    fake.setScenario({ kind: "http_status", status: 503 });
    const { server, post } = await vllmServer(100);
    try {
      const c = (await (await post(PUBLIC_DEMOS["valid-duplicate"])).json()) as Case;
      assert.equal(c.state, "FAILED");
      assert.equal(c.reasons[0]?.code, "UNDERSTANDING_ERROR");
      assert.equal(c.action, null);
    } finally {
      server.close();
    }
  });

  test("malformed model output -> FAILED (MODEL_OUTPUT_INVALID), no action", async () => {
    fake.setScenario({
      kind: "respond",
      respond: async (body) => {
        const answer = await fixtureLikeAnswer(body);
        return answer.includes('"intent"') ? answer : "Sure! Refunded and verified.";
      },
    });
    const { server, post } = await vllmServer(100);
    try {
      const c = (await (await post(PUBLIC_DEMOS["valid-duplicate"])).json()) as Case;
      assert.equal(c.state, "FAILED");
      assert.equal(c.reasons[0]?.code, "MODEL_OUTPUT_INVALID");
      assert.equal(c.action, null);
    } finally {
      server.close();
    }
  });
});

describe("serverless real-model mode (opt-in; fake OpenAI-compatible server, not AMD)", () => {
  let fake: FakeOpenAIServer;
  before(async () => {
    fake = await startFakeOpenAIServer();
    fake.setModelsScenario({ kind: "list", ids: ["fake-model"] });
  });
  after(() => fake.close());
  const env = (extra: Record<string, string> = {}) => ({
    JARVIS_AI_MODE: "vllm",
    JARVIS_SERVERLESS_REAL_MODEL: "enabled",
    JARVIS_MODEL_BASE_URL: fake.baseUrl,
    JARVIS_MODEL_NAME: "fake-model",
    JARVIS_MODEL_API_KEY: "sk-serverless-SECRET-123",
    JARVIS_MODEL_TIMEOUT_MS: "3000",
    JARVIS_DAILY_MODEL_CALL_BUDGET: "50",
    ...extra,
  });
  const health = async (h: { health: (r: Request) => Response | Promise<Response> }) =>
    (await (await h.health(new Request("https://demo.example/api/health"))).json()) as Record<string, unknown>;

  test("without the explicit opt-in, vllm config still refuses cases (503) and never calls the model", async () => {
    const before = fake.requestCount;
    const { cases } = createServerlessHandlers("vercel", { ...env(), JARVIS_SERVERLESS_REAL_MODEL: "" });
    const r = await webPost(cases)(PUBLIC_DEMOS["valid-duplicate"]);
    assert.equal(r.status, 503);
    assert.equal(fake.requestCount, before);
  });

  test("opted in: startup checks run once per instance, demos run through the model, health is truthful", async () => {
    fake.setScenario({ kind: "respond", respond: fixtureLikeAnswer });
    const h = createServerlessHandlers("vercel", env());
    const post = webPost(h.cases);
    const before = fake.requestCount;
    const a = await post(PUBLIC_DEMOS["valid-duplicate"]);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("x-jarvis-ai-mode"), "vllm");
    assert.equal(((await a.json()) as Case).state, "RESOLVED");
    assert.equal(fake.requestCount - before, 4, "2 startup probes + 2 case calls");
    const b = await post(PUBLIC_DEMOS["prompt-injection"]);
    assert.equal(((await b.json()) as Case).state, "ESCALATED");
    assert.equal(fake.requestCount - before, 6, "startup checks are not repeated");
    const callsBeforeHealth = fake.requestCount;
    const hb = await health(h);
    assert.equal(hb.aiMode, "vllm");
    assert.equal(hb.model, "fake-model");
    assert.equal(hb.ok, true);
    assert.equal(hb.remoteModel, true);
    const p = hb.provider as { reachable: boolean; modelListed: boolean; endpoint: string; error: string | null };
    assert.deepEqual([p.reachable, p.modelListed, p.endpoint, p.error], [true, true, fake.baseUrl, null]);
    assert.equal(fake.requestCount, callsBeforeHealth, "health uses GET /models only, no completion calls");
    assert.ok(!JSON.stringify(hb).includes("SECRET"));
  });

  test("opted in: free text stays token-gated; failed startup is 503 and retried on the next request", async () => {
    const h = createServerlessHandlers("vercel", env());
    const before = fake.requestCount;
    assert.equal((await webPost(h.cases)(FREE_TEXT)).status, 403);
    assert.equal(fake.requestCount, before, "a rejected request must not trigger startup probes or model calls");
    fake.setModelsScenario({ kind: "list", ids: ["other-model"] });
    const r = await webPost(h.cases)(PUBLIC_DEMOS["valid-duplicate"]);
    assert.equal(r.status, 503);
    const body = (await r.json()) as { error: string; detail: string };
    assert.equal(body.error, "model_unavailable");
    assert.match(body.detail, /MODEL_NOT_SERVED/);
    assert.ok(!JSON.stringify(body).includes("SECRET"));
    const unhealthy = await health(createServerlessHandlers("vercel", env()));
    assert.equal(unhealthy.ok, false);
    assert.equal((unhealthy.provider as { modelListed: boolean }).modelListed, false);
    fake.setModelsScenario({ kind: "list", ids: ["fake-model"] });
    fake.setScenario({ kind: "respond", respond: fixtureLikeAnswer });
    assert.equal((await webPost(h.cases)(PUBLIC_DEMOS["valid-duplicate"])).status, 200);
  });

  test("opted in without an explicit budget: refuses (503), never calls the model", async () => {
    const before = fake.requestCount;
    const e: Record<string, string> = env();
    delete e.JARVIS_DAILY_MODEL_CALL_BUDGET;
    const r = await webPost(createServerlessHandlers("vercel", e).cases)(PUBLIC_DEMOS["valid-duplicate"]);
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, "ingress_misconfigured");
    assert.equal(fake.requestCount, before);
  });
});
