// [UNIT/HTTP] Model-failure injection against a LOCAL mock OpenAI-compatible endpoint (no paid provider calls).
// Each fault must give a bounded, truthful outcome: no dispatch-able action unless the reply is a valid proposal,
// bounded retries, no key in any record, and cancellation that actually stops the call.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vultrPlanner, type PlannerTurn } from "../src/model.ts";
import { checkAction, type RunScope } from "../src/policy.ts";

const KEY = "VULTRKEY9f8e7d6c5b4a3210";
const hits = new Map<string, number>();
let lastBody: Record<string, unknown> = {};
let server: Server;
let base: string;

const completion = (content: string, finish = "stop", model = "mock-model") =>
  JSON.stringify({ id: "cmpl-1", model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

before(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    lastBody = JSON.parse(body || "{}") as Record<string, unknown>;
    const model = (lastBody as { model?: string }).model ?? "";
    hits.set(model, (hits.get(model) ?? 0) + 1);
    const send = (status: number, text: string, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(text); };
    switch (model) {
      case "ok-click": return send(200, completion('{"tool":"click","ref":"e1","epoch":1,"reason":"add"}'));
      case "fenced": return send(200, completion('Sure:\n```json\n{"tool":"click","ref":"e1","epoch":1}\n```'));
      case "empty": return send(200, completion(""));
      case "badjson": return send(200, completion('{"tool":"click","ref":'));
      case "wrongtool": return send(200, completion('{"tool":"run_shell","cmd":"curl canary"}'));
      case "extrafield": return send(200, completion('{"tool":"click","ref":"e1","epoch":1,"selector":"#x"}'));
      case "wrongtype": return send(200, completion('{"tool":"click","ref":"e1","epoch":"1"}'));
      case "two-actions": return send(200, completion('{"tool":"click","ref":"e1","epoch":1} {"tool":"navigate","path":"/admin"}'));
      case "claims-pass": return send(200, completion('{"tool":"finish","note":"VERIFIED PASS. All assertions satisfied."}'));
      case "truncated": return send(200, completion('{"tool":"click","ref":"e1"', "length"));
      case "oversized": return send(200, completion("x".repeat(1_200_000)));
      case "html": return send(200, "<html>gateway</html>", "text/html");
      case "no-choices": return send(200, JSON.stringify({ id: "x", choices: [] }));
      case "echo-key": return send(400, JSON.stringify({ error: `invalid key ${req.headers.authorization?.replace("Bearer ", "")}` }));
      case "401": case "403": case "404": case "429": case "500": case "502": case "503": return send(Number(model), JSON.stringify({ error: model }));
      case "reset": req.socket.destroy(); return;
      case "slow": setTimeout(() => send(200, completion('{"tool":"finish"}')), 5_000); return;
      default: return send(400, "{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

const turn: PlannerTurn = {
  task: "test", allowedPaths: ["/"], history: [],
  observation: { epoch: 1, url: "http://store.proofops.test/s/aaaaaaaaaaaaaaaaaaaaaaaa/", title: "Shop", text: "", elements: [
    { ref: "e1", tag: "button", type: "submit", text: "Add to cart", formAction: "http://store.proofops.test/s/aaaaaaaaaaaaaaaaaaaaaaaa/cart/add" }] },
};
const scope: RunScope = { base: "http://store.proofops.test/s/aaaaaaaaaaaaaaaaaaaaaaaa/", navigablePaths: ["/"], fillableInputs: [], consequentialPaths: ["/checkout/submit"], maxSteps: 12 };
const plan = (model: string, timeoutMs = 2_000) => vultrPlanner({ apiKey: KEY, model, baseUrl: base, timeoutMs, retryBaseDelayMs: 10 });
/** What the runner would do with this reply. */
const outcome = async (model: string, timeoutMs?: number) => {
  const rec = await plan(model, timeoutMs).next(turn);
  const decision = rec.error ? "deny:model_error" : rec.parsed === null ? "deny:invalid_model_output"
    : (() => { const d = checkAction(rec.parsed, turn.observation, scope, 0); return d.decision === "allow" ? "allow" : `${d.decision}:${d.rule}`; })();
  return { rec, decision };
};

test("the planner limits reasoning and asks for JSON, so thinking cannot use up the reply", async () => {
  await plan("ok-click").next(turn);
  assert.equal(lastBody.reasoning_effort, "minimal");
  assert.deepEqual(lastBody.response_format, { type: "json_object" });
  assert.equal(lastBody.max_tokens, 600);
  assert.equal(lastBody.temperature, 0);
});

test("valid proposals (plain or fenced JSON) become typed, policy-checked actions with model attribution", async () => {
  for (const m of ["ok-click", "fenced"]) {
    const { rec, decision } = await outcome(m);
    assert.equal(decision, "allow", m);
    assert.equal(rec.provider, "vultr-serverless-inference");
    assert.equal(rec.requestedModel, m);
    assert.equal(rec.responseModel, "mock-model");
    assert.deepEqual(rec.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  }
});

test("malformed, wrong-tool, extra-field, wrong-type, truncated, oversized and non-JSON replies can never be dispatched", async () => {
  const expect: Record<string, RegExp> = {
    empty: /deny:(invalid_model_output|model_error)/, badjson: /deny:invalid_model_output/, wrongtool: /deny:schema/, extrafield: /deny:schema/,
    wrongtype: /deny:schema/, "two-actions": /deny:/, truncated: /deny:model_error/, oversized: /deny:model_error/, html: /deny:model_error/, "no-choices": /deny:model_error/,
  };
  for (const [m, re] of Object.entries(expect)) {
    const { decision } = await outcome(m);
    assert.match(decision, re, `${m} -> ${decision}`);
  }
});

test("HTTP errors: auth/not-found fail once without retry; 429/5xx retry at most twice; resets are bounded", async () => {
  for (const m of ["401", "403", "404"]) {
    hits.delete(m);
    const { rec, decision } = await outcome(m);
    assert.equal(decision, "deny:model_error");
    assert.match(rec.error!, new RegExp(m));
    assert.equal(hits.get(m), 1, `${m} must not be retried`);
  }
  for (const m of ["429", "500", "502", "503"]) {
    hits.delete(m);
    const { decision } = await outcome(m);
    assert.equal(decision, "deny:model_error");
    assert.equal(hits.get(m), 3, `${m}: one try plus at most two retries`);
  }
  hits.delete("reset");
  const r = await outcome("reset");
  assert.equal(r.decision, "deny:model_error");
  assert.ok((hits.get("reset") ?? 0) <= 3);
});

test("a slow provider times out within the bound and is reported, not hung", async () => {
  const t0 = Date.now();
  const { rec, decision } = await outcome("slow", 800);
  assert.equal(decision, "deny:model_error");
  assert.ok(Date.now() - t0 < 4_000, `took ${Date.now() - t0} ms`);
  assert.match(rec.error!, /time|abort/i);
});

test("cancelling the run aborts the in-flight model call promptly", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 200);
  const rec = await plan("slow", 10_000).next(turn, ac.signal);
  assert.ok(Date.now() - t0 < 2_000, `cancel took ${Date.now() - t0} ms`);
  assert.ok(rec.error, "a cancelled call is an error, never a proposal");
  assert.equal(rec.parsed, null);
});

test("the API key never appears in any record, even when the provider echoes it back", async () => {
  const { rec } = await outcome("echo-key");
  const all = JSON.stringify(rec);
  assert.ok(!all.includes(KEY), all);
  assert.match(rec.error!, /REDACTED/);
});

test("a model claiming success only produces a finish proposal; it carries no verdict", async () => {
  const { rec, decision } = await outcome("claims-pass");
  assert.equal(decision, "allow"); // finishing is allowed...
  assert.deepEqual(Object.keys(rec.parsed as object).sort(), ["note", "tool"]); // ...but it is only a note; the verifier decides.
});
