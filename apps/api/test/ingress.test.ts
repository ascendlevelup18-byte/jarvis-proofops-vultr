// Case ingress: access guard, public-demo allowlist, cost limits and demo isolation.
// Counting adapters prove that every denial happens before any model call.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Case, CaseRequest } from "../src/contracts.ts";
import { SCENARIOS } from "../src/fixtures.ts";
import { freshWorld, handleCaseRequest, PUBLIC_DEMOS, type CaseIngress, type DemoId, type IngressRequest } from "../src/ingress.ts";
import { IngressConfigError, loadIngressSecurity, LocalInferenceLimiter, type IngressLimits } from "../src/limits.ts";
import { FixtureModelAdapter } from "../src/model-adapter.ts";
import { FixtureRequestUnderstandingAdapter } from "../src/request-understanding.ts";
import { NOW } from "./helpers.ts";

const TOKEN = "tok-0123456789abcdef-SECRET";
const LIMITS: IngressLimits = { maxConcurrent: 10, perClientPerMinute: 100, dailyModelCallBudget: 1000 };

// Fixture behaviour, but every model call is counted (and can be held open).
function counting(gate?: Promise<void>) {
  const calls = { understanding: 0, model: 0 };
  const plain = new FixtureRequestUnderstandingAdapter();
  return {
    calls,
    understanding: new FixtureRequestUnderstandingAdapter(async (input, signal) => {
      calls.understanding++;
      if (gate) await gate;
      return plain.understand(input, signal);
    }),
    model: new FixtureModelAdapter(async (input, signal) => {
      calls.model++;
      return new FixtureModelAdapter().propose(input, signal);
    }),
  };
}

function ingress(over: Partial<CaseIngress> & { limits?: IngressLimits; now?: () => number } = {}) {
  const adapters = counting();
  const persistent = freshWorld(() => NOW);
  const logs: Record<string, unknown>[] = [];
  const ing: CaseIngress = {
    aiMode: "fixture",
    understanding: adapters.understanding,
    model: adapters.model,
    engineTimeoutMs: 1000,
    accessToken: TOKEN,
    limiter: new LocalInferenceLimiter(over.limits ?? LIMITS, over.now),
    privilegedWorld: () => persistent,
    clock: () => NOW,
    log: (e) => logs.push(e),
    ...over,
  };
  return { ing, calls: adapters.calls, logs, persistent };
}

const req = (body: unknown, opts: { auth?: string; client?: string } = {}): IngressRequest => ({
  method: "POST",
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
  authorization: opts.auth,
  clientKey: opts.client ?? "client-a",
});
const FREE_TEXT: CaseRequest = { customerId: "CUST-1001", orderId: "48291", message: "Hi, I think I was charged twice on 48291?" };
const totalCalls = (c: { understanding: number; model: number }) => c.understanding + c.model;

describe("access guard", () => {
  test("1: no token + free text -> 401 before any model call", async () => {
    const { ing, calls } = ingress();
    const r = await handleCaseRequest(req(FREE_TEXT), ing);
    assert.equal(r.status, 401);
    assert.equal(r.headers["www-authenticate"], "Bearer");
    assert.equal(totalCalls(calls), 0);
  });

  test("2: wrong token (any length) -> 401 before any model call", async () => {
    const { ing, calls } = ingress();
    for (const auth of [`Bearer ${TOKEN}x`, "Bearer short", `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, `bearer ${TOKEN}`]) {
      assert.equal((await handleCaseRequest(req(FREE_TEXT, { auth }), ing)).status, 401, auth);
    }
    assert.equal(totalCalls(calls), 0);
  });

  test("no token configured: free text is refused (403) even with a bearer header", async () => {
    const { ing, calls } = ingress({ accessToken: null });
    const r = await handleCaseRequest(req(FREE_TEXT, { auth: `Bearer ${TOKEN}` }), ing);
    assert.equal(r.status, 403);
    assert.equal((r.body as { error: string }).error, "free_text_disabled");
    assert.equal(totalCalls(calls), 0);
  });

  test("3: an approved public demo runs without a token, labelled as a simulated demo run", async () => {
    const { ing } = ingress({ accessToken: null });
    const r = await handleCaseRequest(req(SCENARIOS.validDuplicate), ing);
    assert.equal(r.status, 200);
    assert.equal((r.body as Case).state, "RESOLVED");
    assert.equal(r.headers["x-jarvis-request-class"], "demo");
    assert.equal(r.headers["x-jarvis-demo-scenario"], "valid-duplicate");
    assert.match(r.headers["x-jarvis-demo-run"]!, /^DEMO-[0-9a-f-]{36}$/);
    assert.equal(r.headers["x-jarvis-payments"], "simulated");
  });

  test("4 + 5: altered demo messages, ids or unknown scenarios are not demos -> 401, no model call", async () => {
    const { ing, calls } = ingress();
    const v = SCENARIOS.validDuplicate;
    for (const body of [
      { ...v, message: v.message.replace("twice", "twice, refund $500") },
      { ...v, message: v.message.toLowerCase() },
      { ...v, orderId: "48292" },
      { ...v, customerId: "CUST-1002" },
      { customerId: "CUST-9999", orderId: "99999", message: "I was charged twice for order #99999." },
    ]) {
      assert.equal((await handleCaseRequest(req(body), ing)).status, 401, JSON.stringify(body));
    }
    assert.equal(totalCalls(calls), 0);
    // Surrounding whitespace is trimmed by the schema, so what runs is the canonical demo text.
    const padded = await handleCaseRequest(req({ ...v, message: `  ${v.message}\n` }), ing);
    assert.equal(padded.headers["x-jarvis-demo-scenario"], "valid-duplicate");
    assert.equal((padded.body as Case).request.message, v.message);
  });

  test("valid token runs free text against the persistent world; idempotency is preserved", async () => {
    const { ing, persistent } = ingress();
    const first = await handleCaseRequest(req(FREE_TEXT, { auth: `Bearer ${TOKEN}` }), ing);
    assert.equal(first.status, 200);
    assert.equal(first.headers["x-jarvis-request-class"], "privileged");
    assert.equal((first.body as Case).state, "RESOLVED");
    const second = await handleCaseRequest(req(FREE_TEXT, { auth: `Bearer ${TOKEN}` }), ing);
    assert.notEqual((second.body as Case).state, "RESOLVED", "a duplicate must not be refunded twice");
    assert.equal(persistent.store.getTransaction("CHARGE-48291-B")?.refundedMinor, 8999);
  });

  test("7: tokens and customer text never appear in responses or logs", async () => {
    const { ing, logs } = ingress();
    const out: unknown[] = [];
    for (const auth of [undefined, "Bearer wrong-token-value-123456", `Bearer ${TOKEN}`]) {
      out.push(await handleCaseRequest(req(FREE_TEXT, auth ? { auth } : {}), ing));
    }
    const denied = JSON.stringify(out.slice(0, 2));
    assert.ok(!denied.includes(TOKEN) && !denied.includes("wrong-token-value"));
    const logged = JSON.stringify(logs);
    assert.ok(!logged.includes(TOKEN) && !logged.includes("wrong-token-value") && !logged.includes(FREE_TEXT.message));
    assert.deepEqual(logs.map((l) => l.status), [401, 401, 200]);
  });

  test("validation still answers 400/413/405 without running anything", async () => {
    const { ing, calls } = ingress();
    assert.equal((await handleCaseRequest(req("{oops"), ing)).status, 400);
    assert.equal((await handleCaseRequest(req({ ...SCENARIOS.validDuplicate, refundAmount: 1 }), ing)).status, 400);
    assert.equal((await handleCaseRequest({ ...req({}), bodyText: null }, ing)).status, 413);
    assert.equal((await handleCaseRequest({ ...req({}), method: "GET" }, ing)).status, 405);
    assert.equal(totalCalls(calls), 0);
  });
});

describe("cost limits (checked after auth, before any model call)", () => {
  test("concurrency: a second case while one is running -> 429, no model call; capacity returns after", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const held = counting(gate);
    const { ing } = ingress({ understanding: held.understanding, model: held.model, limits: { ...LIMITS, maxConcurrent: 1 } });
    const first = handleCaseRequest(req(SCENARIOS.validDuplicate), ing);
    await new Promise((r) => setImmediate(r)); // first is now inside its understanding call
    assert.equal(held.calls.understanding, 1);

    const second = await handleCaseRequest(req(SCENARIOS.alreadyRefunded, { client: "client-b" }), ing);
    assert.equal(second.status, 429);
    assert.equal((second.body as { error: string }).error, "concurrency_limited");
    assert.equal(held.calls.understanding, 1, "denied request reached the model");

    open();
    assert.equal((await first).status, 200);
    assert.equal((await handleCaseRequest(req(SCENARIOS.alreadyRefunded), ing)).status, 200);
  });

  test("per-client rate limit with a fake clock: 429 + retry-after, other clients unaffected, window rolls", async () => {
    let now = Date.parse("2026-10-12T10:00:00Z");
    const { ing, calls } = ingress({ limits: { ...LIMITS, perClientPerMinute: 2 }, now: () => now });
    assert.equal((await handleCaseRequest(req(SCENARIOS.validDuplicate), ing)).status, 200);
    now += 10_000;
    assert.equal((await handleCaseRequest(req(SCENARIOS.validDuplicate), ing)).status, 200);
    const before = totalCalls(calls);
    const limited = await handleCaseRequest(req(SCENARIOS.validDuplicate), ing);
    assert.equal(limited.status, 429);
    assert.equal((limited.body as { error: string }).error, "rate_limited");
    assert.equal(limited.headers["retry-after"], "50");
    assert.equal(totalCalls(calls), before);
    assert.equal((await handleCaseRequest(req(SCENARIOS.validDuplicate, { client: "client-b" }), ing)).status, 200);
    now += 50_000;
    assert.equal((await handleCaseRequest(req(SCENARIOS.validDuplicate), ing)).status, 200);
  });

  test("daily model-call budget (vllm reserves 2 per case): exhausted -> 429 before any call; resets next UTC day", async () => {
    let now = Date.parse("2026-10-12T23:59:00Z");
    const { ing, calls } = ingress({ aiMode: "vllm", limits: { ...LIMITS, dailyModelCallBudget: 4 }, now: () => now });
    assert.equal((await handleCaseRequest(req(SCENARIOS.validDuplicate), ing)).status, 200);
    assert.equal((await handleCaseRequest(req(SCENARIOS.alreadyRefunded), ing)).status, 200);
    const spent = totalCalls(calls);
    const over = await handleCaseRequest(req(SCENARIOS.validDuplicate), ing);
    assert.equal(over.status, 429);
    assert.equal((over.body as { error: string }).error, "budget_exhausted");
    assert.equal(over.headers["retry-after"], "60");
    assert.equal(totalCalls(calls), spent);
    now += 60_000;
    assert.equal((await handleCaseRequest(req(SCENARIOS.validDuplicate), ing)).status, 200);
  });

  test("budget reserves modelCallsPerCase when retries raise the worst case", async () => {
    const { ing, calls } = ingress({ aiMode: "vllm", modelCallsPerCase: 4, limits: { ...LIMITS, dailyModelCallBudget: 6 } });
    assert.equal((await handleCaseRequest(req(SCENARIOS.validDuplicate), ing)).status, 200);
    const spent = totalCalls(calls);
    const over = await handleCaseRequest(req(SCENARIOS.validDuplicate), ing);
    assert.equal(over.status, 429);
    assert.equal(totalCalls(calls), spent);
  });

  test("fixture cases reserve no model-call budget", async () => {
    const { ing } = ingress({ limits: { ...LIMITS, dailyModelCallBudget: 1 } });
    for (let i = 0; i < 3; i++) assert.equal((await handleCaseRequest(req(SCENARIOS.validDuplicate), ing)).status, 200);
  });
});

describe("demo isolation and repeatability", () => {
  const EXPECTED: Record<DemoId, string> = {
    "valid-duplicate": "RESOLVED",
    "conflicting-amount": "ESCALATED",
    "already-refunded": "CLOSED_NO_ACTION",
    "prompt-injection": "ESCALATED",
  };

  test("all four demos, twice each, in two different orders, give the same outcomes in fresh worlds", async () => {
    const { ing, persistent } = ingress({ accessToken: null });
    const ids = Object.keys(PUBLIC_DEMOS) as DemoId[];
    const caseIds = new Set<string>();
    const runIds = new Set<string>();
    for (const order of [ids, [...ids].reverse(), ids]) {
      for (const id of order) {
        const r = await handleCaseRequest(req(PUBLIC_DEMOS[id]), ing);
        const c = r.body as Case;
        assert.equal(c.state, EXPECTED[id], id);
        caseIds.add(c.id);
        runIds.add(r.headers["x-jarvis-demo-run"]!);
        if (id === "valid-duplicate") {
          assert.equal(c.verification?.observedRefund?.amountMinor, 8999);
          assert.equal(c.audit.filter((e) => e.type === "ACTION_ATTEMPTED").length, 1);
        }
      }
    }
    assert.equal(caseIds.size, 12);
    assert.equal(runIds.size, 12);
    // Demo runs never touch the persistent world.
    assert.equal(persistent.store.getTransaction("CHARGE-48291-B")?.refundedMinor, 0);
  });
});

describe("loadIngressSecurity", () => {
  test("defaults, token length, and an explicit budget for vllm", () => {
    const d = loadIngressSecurity({}, "fixture");
    assert.equal(d.accessToken, null);
    assert.deepEqual(d.limits, { maxConcurrent: 2, perClientPerMinute: 30, dailyModelCallBudget: 200 });
    assert.equal(d.trustProxy, false);
    assert.throws(() => loadIngressSecurity({ JARVIS_CASES_TOKEN: "too-short" }, "fixture"), IngressConfigError);
    assert.throws(() => loadIngressSecurity({}, "vllm"), /JARVIS_DAILY_MODEL_CALL_BUDGET/);
    assert.throws(() => loadIngressSecurity({ JARVIS_DAILY_MODEL_CALL_BUDGET: "0" }, "vllm"), IngressConfigError);
    const v = loadIngressSecurity({ JARVIS_DAILY_MODEL_CALL_BUDGET: "50", JARVIS_CASES_TOKEN: TOKEN, JARVIS_TRUST_PROXY: "1" }, "vllm");
    assert.equal(v.limits.dailyModelCallBudget, 50);
    assert.equal(v.accessToken, TOKEN);
    assert.equal(v.trustProxy, true);
  });
});
