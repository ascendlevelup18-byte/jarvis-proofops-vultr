// vLLM adapter tests (§G of docs/KICKOFF_IMPLEMENTATION_PACKAGE.md) against the fake
// OpenAI-compatible server. No AMD access needed. Composition/startup (§G row 24) is
// the next gate and is not covered here.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Case, CaseRequest } from "../src/contracts.ts";
import { runCase } from "../src/case-engine.ts";
import { REFUND_POLICY, SCENARIOS } from "../src/fixtures.ts";
import { createHash } from "node:crypto";
import {
  buildDecisionMessages,
  buildModelInput,
  DECISION_INSTRUCTIONS,
  decisionPromptVersion,
  VllmModelAdapter,
} from "../src/model-adapter.ts";
import { OpenAICompatibleClient, ProviderError } from "../src/provider/index.ts";
import {
  parseStructuredRequest,
  UNDERSTANDING_PROMPT_VERSION,
  UNDERSTANDING_SYSTEM_PROMPT,
  VllmRequestUnderstandingAdapter,
} from "../src/request-understanding.ts";
import { startFakeOpenAIServer, type FakeOpenAIServer } from "./fake-openai-server.ts";
import { makeDeps, proposal, reasonDetails, refunded, statePath, type TestDeps } from "./helpers.ts";

const MODEL = "fake-model";

const clientFor = (fake: FakeOpenAIServer, opts: { timeoutMs?: number; maxResponseBytes?: number } = {}) =>
  new OpenAICompatibleClient({
    baseUrl: fake.baseUrl,
    model: MODEL,
    timeoutMs: opts.timeoutMs ?? 5000,
    ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
  });

const understood = (intent: string, mentionedAmounts: unknown[] = []) => JSON.stringify({ intent, mentionedAmounts });
const DUP = understood("DUPLICATE_CHARGE_REFUND");

interface ChatBody {
  model: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: string; json_schema: { name: string; strict: boolean; schema: unknown } };
  messages: { role: string; content: string }[];
}
const bodyOf = (fake: FakeOpenAIServer) => fake.lastRequestBody as ChatBody;

describe("vLLM adapters (fake OpenAI-compatible server)", () => {
  let u: FakeOpenAIServer; // serves the understanding adapter
  let m: FakeOpenAIServer; // serves the decision adapter

  before(async () => {
    u = await startFakeOpenAIServer();
    m = await startFakeOpenAIServer();
  });
  after(async () => {
    await u.close();
    await m.close();
  });

  const deps = (opts: { modelTimeoutMs?: number; u?: OpenAICompatibleClient; m?: OpenAICompatibleClient } = {}) =>
    makeDeps({
      understanding: new VllmRequestUnderstandingAdapter(opts.u ?? clientFor(u)),
      model: new VllmModelAdapter(opts.m ?? clientFor(m)),
      modelTimeoutMs: opts.modelTimeoutMs ?? 3000,
    });

  // Scripts both fake models, then runs one case end to end through the real engine.
  async function run(
    request: CaseRequest,
    understanding: string,
    decision: string,
    d: TestDeps = deps(),
  ): Promise<{ c: Case; d: TestDeps }> {
    u.setScenario({ kind: "ok", content: understanding });
    m.setScenario({ kind: "ok", content: decision });
    return { c: await runCase(request, d), d };
  }

  // ---------- adapter contract ----------

  test("ids name the configured model; prompt versions are sha256 hex", () => {
    assert.equal(new VllmRequestUnderstandingAdapter(clientFor(u)).id, "vllm:fake-model");
    assert.equal(new VllmModelAdapter(clientFor(m)).id, "vllm:fake-model");
    assert.match(UNDERSTANDING_PROMPT_VERSION, /^[0-9a-f]{64}$/);
    assert.equal(UNDERSTANDING_PROMPT_VERSION, createHash("sha256").update(UNDERSTANDING_SYSTEM_PROMPT).digest("hex"));
    assert.match(decisionPromptVersion(REFUND_POLICY.sections), /^[0-9a-f]{64}$/);
  });

  test("decision prompt version fingerprints the complete effective system prompt", async () => {
    const policy = REFUND_POLICY.sections;
    const v = decisionPromptVersion(policy);
    assert.equal(decisionPromptVersion(policy), v, "deterministic");
    // Equals sha256 of the system message actually sent, for any case: no case data in it.
    const sent: string[] = [];
    for (const req of [SCENARIOS.validDuplicate, SCENARIOS.promptInjection]) {
      const { c } = await run(req, DUP, proposal());
      assert.ok(c.evidence);
      sent.push(bodyOf(m).messages[0]!.content);
      assert.equal(sent.at(-1), buildDecisionMessages(buildModelInput(c.id, req.message, c.evidence))[0]!.content);
    }
    assert.equal(sent[0], sent[1]);
    assert.equal(createHash("sha256").update(sent[0]!).digest("hex"), v);
    // Any instruction or policy change changes the version.
    assert.notEqual(decisionPromptVersion(policy, DECISION_INSTRUCTIONS + " "), v);
    assert.notEqual(decisionPromptVersion(policy, DECISION_INSTRUCTIONS.replace("ESCALATE", "ESCALATE.")), v);
    assert.notEqual(decisionPromptVersion([...policy.slice(0, -1), { ...policy.at(-1)!, text: policy.at(-1)!.text + "!" }]), v);
    assert.notEqual(decisionPromptVersion(policy.slice(1)), v);
  });

  test("row 1: valid understanding parses; request follows the §D contract", async () => {
    u.setScenario({ kind: "ok", content: understood("DUPLICATE_CHARGE_REFUND", [{ text: "$89.99", amountMinor: 8999, currency: "USD" }]) });
    const adapter = new VllmRequestUnderstandingAdapter(clientFor(u));
    const raw = await adapter.understand({ untrusted: { customerMessage: "Charged twice, $89.99" } }, new AbortController().signal);
    const parsed = parseStructuredRequest(raw);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.intent, "DUPLICATE_CHARGE_REFUND");
    assert.deepEqual(parsed.value.mentionedAmounts, [{ text: "$89.99", amountMinor: 8999, currency: "USD" }]);

    const body = bodyOf(u);
    assert.equal(body.model, MODEL);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.response_format?.type, "json_schema");
    assert.equal(body.response_format?.json_schema.name, "structured_request");
    assert.equal(body.response_format?.json_schema.strict, true);
    assert.deepEqual(body.messages.map((x) => x.role), ["system", "user"]);
    assert.equal(body.messages[0]!.content, UNDERSTANDING_SYSTEM_PROMPT);
    assert.equal(body.messages[1]!.content, JSON.stringify({ untrusted_customer_message: "Charged twice, $89.99" }));
  });

  test("structured output can be disabled: no response_format is sent", async () => {
    u.setScenario({ kind: "ok", content: DUP });
    m.setScenario({ kind: "ok", content: proposal() });
    const signal = new AbortController().signal;
    await new VllmRequestUnderstandingAdapter(clientFor(u), { structuredOutput: false }).understand({ untrusted: { customerMessage: "x" } }, signal);
    assert.equal(bodyOf(u).response_format, undefined);
    const d = deps({ m: clientFor(m) });
    d.model = new VllmModelAdapter(clientFor(m), { structuredOutput: false });
    await runCase(SCENARIOS.validDuplicate, d);
    assert.equal(bodyOf(m).response_format, undefined);
  });

  test("json_object mode: response_format {type: json_object} with no schema, for JSON-mode-only servers", async () => {
    u.setScenario({ kind: "ok", content: DUP });
    m.setScenario({ kind: "ok", content: proposal() });
    const signal = new AbortController().signal;
    await new VllmRequestUnderstandingAdapter(clientFor(u), { structuredOutput: "json_object" }).understand({ untrusted: { customerMessage: "x" } }, signal);
    assert.deepEqual(bodyOf(u).response_format, { type: "json_object" });
    assert.match(bodyOf(u).messages[0]!.content, /JSON/, "JSON mode needs the prompt to ask for JSON");
    const d = deps({ m: clientFor(m) });
    d.model = new VllmModelAdapter(clientFor(m), { structuredOutput: "json_object" });
    const c = await runCase(SCENARIOS.validDuplicate, d);
    assert.deepEqual(bodyOf(m).response_format, { type: "json_object" });
    assert.match(bodyOf(m).messages.map((x) => x.content).join("\n"), /JSON/);
    assert.equal(c.state, "RESOLVED", reasonDetails(c));
  });

  test("row 2: valid proposal reaches policy and resolves with a verified refund; request follows §E", async () => {
    const { c, d } = await run(SCENARIOS.validDuplicate, DUP, proposal());
    assert.equal(c.state, "RESOLVED", reasonDetails(c));
    assert.equal(refunded(d, "CHARGE-48291-B"), 8999);
    assert.ok(c.audit.some((e) => e.type === "MODEL_CALL" && (e.data as { adapter: string }).adapter === "vllm:fake-model"));

    const body = bodyOf(m);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 768);
    assert.equal(body.response_format?.json_schema.name, "decision_proposal");
    assert.equal(body.response_format?.json_schema.strict, true);
    const [system, user] = body.messages;
    assert.match(system!.content, /^You analyse a duplicate-charge case/); // input.instructions first
    assert.match(system!.content, /POLICY \(authoritative\):\n\[DUP-1\] /);
    assert.match(system!.content, /INPUT BOUNDARIES:/);
    const userObj = JSON.parse(user!.content) as Record<string, unknown>;
    assert.deepEqual(Object.keys(userObj), ["authoritative_evidence", "untrusted_customer_message"]);
    assert.equal(userObj.untrusted_customer_message, SCENARIOS.validDuplicate.message);
    assert.equal((userObj.authoritative_evidence as { order: { id: string } }).order.id, "48291");
  });

  // ---------- malformed / non-schema output: strict parse fails closed ----------

  for (const [label, content] of [
    ["row 3: malformed JSON", '{"intent":'],
    ["row 4: text around JSON (no extraction)", `Here: ${DUP}`],
    ["row 9: wrong intent enum", understood("REFUND_ALL")],
  ] as const) {
    test(`${label} in understanding -> UNDERSTANDING_OUTPUT_INVALID, FAILED, no refund`, async () => {
      const { c, d } = await run(SCENARIOS.validDuplicate, content, proposal());
      assert.equal(c.state, "FAILED");
      assert.equal(c.reasons[0]?.code, "UNDERSTANDING_OUTPUT_INVALID");
      assert.equal(refunded(d, "CHARGE-48291-B"), 0);
    });
  }

  for (const [label, content] of [
    ["row 3: malformed JSON", '{"action":'],
    ["row 4: text around JSON (no extraction)", `Sure! ${proposal()}`],
    ["row 7: missing fields", '{"action":"REFUND_DUPLICATE"}'],
    ["row 8: extra amount field", proposal({ refundAmountMinor: 500000 })],
    ["row 9: wrong action enum", proposal({ action: "EXECUTE_REFUND" })],
    ["row 13: model asks to execute", proposal({ action: "EXECUTE" })],
    ["row 14: model claims verified", proposal({ verified: true })],
  ] as const) {
    test(`${label} in decision -> MODEL_OUTPUT_INVALID, FAILED, no refund`, async () => {
      const { c, d } = await run(SCENARIOS.validDuplicate, DUP, content);
      assert.equal(c.state, "FAILED");
      assert.equal(c.reasons[0]?.code, "MODEL_OUTPUT_INVALID");
      assert.equal(c.action, null);
      assert.equal(refunded(d, "CHARGE-48291-B"), 0);
    });
  }

  test("row 5: markdown-fenced JSON parses in both stages", async () => {
    u.setScenario({ kind: "code_fenced", content: DUP });
    m.setScenario({ kind: "code_fenced", content: proposal() });
    const c = await runCase(SCENARIOS.validDuplicate, deps());
    assert.equal(c.state, "RESOLVED", reasonDetails(c));
  });

  test("row 6: <think> reasoning wrapper is stripped in both stages", async () => {
    u.setScenario({ kind: "reasoning_then_json", content: DUP });
    m.setScenario({ kind: "reasoning_then_json", content: proposal() });
    const c = await runCase(SCENARIOS.validDuplicate, deps());
    assert.equal(c.state, "RESOLVED", reasonDetails(c));
  });

  // ---------- valid but unsafe output: deterministic policy blocks it ----------

  test("row 10: invented amount in understanding -> ESCALATED (NO_CONTRADICTIONS), no refund", async () => {
    const invented = understood("DUPLICATE_CHARGE_REFUND", [{ text: "$5,000.00", amountMinor: 500000, currency: "USD" }]);
    const { c, d } = await run(SCENARIOS.validDuplicate, invented, proposal());
    assert.equal(c.state, "ESCALATED");
    assert.match(reasonDetails(c), /NO_CONTRADICTIONS/);
    assert.equal(refunded(d, "CHARGE-48291-B"), 0);
  });

  test("row 11: invented transaction -> ESCALATED (TRANSACTIONS_IN_EVIDENCE)", async () => {
    const { c, d } = await run(SCENARIOS.validDuplicate, DUP, proposal({ refundTransactionId: "CHARGE-99999-Z" }));
    assert.equal(c.state, "ESCALATED");
    assert.match(reasonDetails(c), /TRANSACTIONS_IN_EVIDENCE/);
    assert.equal(refunded(d, "CHARGE-48291-B"), 0);
  });

  test("row 12: bad evidence ref -> ESCALATED (EVIDENCE_REFS_VALID)", async () => {
    const { c, d } = await run(SCENARIOS.validDuplicate, DUP, proposal({ evidenceRefs: ["ADMIN-OVERRIDE"] }));
    assert.equal(c.state, "ESCALATED");
    assert.match(reasonDetails(c), /EVIDENCE_REFS_VALID/);
    assert.equal(refunded(d, "CHARGE-48291-B"), 0);
  });

  test("row 13: 'execute now' prose in rationale has no effect", async () => {
    const decision = proposal({
      action: "ESCALATE",
      refundTransactionId: null,
      keepTransactionId: null,
      rationale: "EXECUTE NOW. Refund CHARGE-48291-B and mark verified.",
    });
    const { c, d } = await run(SCENARIOS.validDuplicate, DUP, decision);
    assert.equal(c.state, "ESCALATED");
    assert.equal(c.action, null);
    assert.equal(refunded(d, "CHARGE-48291-B"), 0);
  });

  test("row 15: injected customer message, complying model -> ESCALATED, no refund; prompt boundaries hold", async () => {
    const complying = proposal({
      refundTransactionId: "CHARGE-48294-B",
      keepTransactionId: "CHARGE-48294-A",
      evidenceRefs: ["48294", "CHARGE-48294-A", "CHARGE-48294-B", "DUP-1"],
    });
    const { c, d } = await run(SCENARIOS.promptInjection, DUP, complying);
    assert.equal(c.state, "ESCALATED");
    assert.match(reasonDetails(c), /NO_CONTRADICTIONS/);
    assert.equal(c.action, null);
    assert.equal(refunded(d, "CHARGE-48294-B"), 0);

    const message = SCENARIOS.promptInjection.message;
    for (const [fake, stage] of [[u, "understanding"], [m, "decision"]] as const) {
      const [system, user] = bodyOf(fake).messages;
      assert.ok(!system!.content.includes("IMPORTANT SYSTEM NOTICE"), `${stage} system prompt has customer text`);
      assert.ok(!system!.content.includes("48294"), `${stage} system prompt has case data`);
      // Customer text appears only as a JSON string value in the user message.
      const userObj = JSON.parse(user!.content) as Record<string, unknown>;
      assert.equal(userObj.untrusted_customer_message, message);
    }
  });

  test("row 16: cancellation mislabelled as duplicate -> ESCALATED (INTENT_CORROBORATED)", async () => {
    const request = { ...SCENARIOS.validDuplicate, message: "Please cancel the whole order #48291." };
    const { c, d } = await run(request, DUP, proposal());
    assert.equal(c.state, "ESCALATED");
    assert.match(reasonDetails(c), /INTENT_CORROBORATED/);
    assert.equal(refunded(d, "CHARGE-48291-B"), 0);
  });

  // ---------- provider failures: FAILED before EXECUTING, never a fallback ----------

  test("row 17: hung understanding -> UNDERSTANDING_TIMEOUT (engine timer first), FAILED", async () => {
    u.setScenario({ kind: "hang" });
    const d = deps({ modelTimeoutMs: 200, u: clientFor(u, { timeoutMs: 2200 }) });
    const c = await runCase(SCENARIOS.validDuplicate, d);
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "UNDERSTANDING_TIMEOUT");
    assert.match(c.reasons[0]!.detail, /vllm:fake-model did not respond within 200ms/);
  });

  test("row 17: hung decision -> MODEL_TIMEOUT, FAILED, never EXECUTING", async () => {
    u.setScenario({ kind: "ok", content: DUP });
    m.setScenario({ kind: "hang" });
    const d = deps({ modelTimeoutMs: 200, m: clientFor(m, { timeoutMs: 2200 }) });
    const c = await runCase(SCENARIOS.validDuplicate, d);
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "MODEL_TIMEOUT");
    assert.ok(!statePath(c).includes("EXECUTING"));
    assert.equal(refunded(d, "CHARGE-48291-B"), 0);
  });

  test("client backstop firing first -> MODEL_ERROR 'timed out'", async () => {
    u.setScenario({ kind: "ok", content: DUP });
    m.setScenario({ kind: "hang" });
    const c = await runCase(SCENARIOS.validDuplicate, deps({ modelTimeoutMs: 2000, m: clientFor(m, { timeoutMs: 100 }) }));
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "MODEL_ERROR");
    assert.match(c.reasons[0]!.detail, /timed out/);
  });

  test("caller abort reaches the provider call", async () => {
    u.setScenario({ kind: "hang" });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      new VllmRequestUnderstandingAdapter(clientFor(u)).understand({ untrusted: { customerMessage: "x" } }, ac.signal),
      (e: unknown) => e instanceof ProviderError && e.category === "TIMEOUT",
    );
  });

  test("row 18: connection refused -> UNDERSTANDING_ERROR, FAILED", async () => {
    const dead = await startFakeOpenAIServer();
    const deadClient = clientFor(dead);
    await dead.close();
    const c = await runCase(SCENARIOS.validDuplicate, deps({ u: deadClient }));
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "UNDERSTANDING_ERROR");
    assert.match(c.reasons[0]!.detail, /connection failed/);
  });

  for (const status of [400, 401, 429, 500, 503]) {
    test(`row 19: HTTP ${status} -> MODEL_ERROR, FAILED, detail redacted`, async () => {
      u.setScenario({ kind: "ok", content: DUP });
      m.setScenario({ kind: "http_status", status, body: '{"error":"bad key Bearer sk-secret-123"}' });
      const d = deps();
      const c = await runCase(SCENARIOS.validDuplicate, d);
      assert.equal(c.state, "FAILED");
      assert.equal(c.reasons[0]?.code, "MODEL_ERROR");
      assert.match(c.reasons[0]!.detail, new RegExp(`HTTP ${status}`));
      assert.ok(!JSON.stringify(c).includes("sk-secret-123"), "secret leaked into the case");
      assert.equal(refunded(d, "CHARGE-48291-B"), 0);
    });
  }

  test("row 20: oversized body -> MODEL_ERROR (RESPONSE_TOO_LARGE)", async () => {
    u.setScenario({ kind: "ok", content: DUP });
    m.setScenario({ kind: "large", bytes: 4096 });
    const c = await runCase(SCENARIOS.validDuplicate, deps({ m: clientFor(m, { maxResponseBytes: 1024 }) }));
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "MODEL_ERROR");
    assert.match(c.reasons[0]!.detail, /exceeds 1024 bytes/);
  });

  test("row 21: refusal (content null) -> MODEL_ERROR, FAILED", async () => {
    u.setScenario({ kind: "ok", content: DUP });
    m.setScenario({
      kind: "unexpected_shape",
      body: { id: "r", choices: [{ message: { role: "assistant", content: null, refusal: "I can't help" }, finish_reason: "stop" }] },
    });
    const c = await runCase(SCENARIOS.validDuplicate, deps());
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "MODEL_ERROR");
  });

  test("row 22: truncated output (finish_reason=length) -> *_ERROR, not OUTPUT_INVALID", async () => {
    u.setScenario({ kind: "ok", content: DUP.slice(0, 20), finishReason: "length" });
    const c1 = await runCase(SCENARIOS.validDuplicate, deps());
    assert.equal(c1.reasons[0]?.code, "UNDERSTANDING_ERROR");
    assert.match(c1.reasons[0]!.detail, /finish_reason=length/);

    u.setScenario({ kind: "ok", content: DUP });
    m.setScenario({ kind: "ok", content: proposal(), finishReason: "length" });
    const c2 = await runCase(SCENARIOS.validDuplicate, deps());
    assert.equal(c2.state, "FAILED");
    assert.equal(c2.reasons[0]?.code, "MODEL_ERROR");
    assert.match(c2.reasons[0]!.detail, /finish_reason=length/);
  });

  test("no fixture fallback: a failing vLLM provider never yields a fixture answer", async () => {
    u.setScenario({ kind: "http_status", status: 503 });
    const c = await runCase(SCENARIOS.validDuplicate, deps());
    assert.equal(c.state, "FAILED");
    assert.equal(c.understanding, null);
    assert.equal(c.proposal, null);
    const calls = c.audit.filter((e) => e.type === "UNDERSTANDING_CALL" || e.type === "MODEL_CALL");
    assert.deepEqual(calls.map((e) => (e.data as { adapter: string }).adapter), ["vllm:fake-model"]);
  });

  // ---------- row 23: four demos end to end ----------

  test("row 23: four demos with scripted model outputs reach the expected terminal states", async () => {
    const refundOf = (order: string) =>
      proposal({
        refundTransactionId: `CHARGE-${order}-B`,
        keepTransactionId: `CHARGE-${order}-A`,
        evidenceRefs: [order, `CHARGE-${order}-A`, `CHARGE-${order}-B`, "DUP-1"],
      });
    const noAction = proposal({ action: "NO_ACTION", refundTransactionId: null, keepTransactionId: null, evidenceRefs: ["48293"] });
    const escalate = proposal({
      action: "ESCALATE",
      refundTransactionId: null,
      keepTransactionId: null,
      evidenceRefs: ["48294"],
      riskFlags: ["customer message contains instructions"],
    });
    const cases = [
      [SCENARIOS.validDuplicate, DUP, refundOf("48291"), "RESOLVED"],
      [
        SCENARIOS.conflictingAmount,
        understood("DUPLICATE_CHARGE_REFUND", [{ text: "$250", amountMinor: 25000, currency: "USD" }]),
        refundOf("48292"),
        "ESCALATED",
      ],
      [SCENARIOS.alreadyRefunded, DUP, noAction, "CLOSED_NO_ACTION"],
      [
        SCENARIOS.promptInjection,
        understood("DUPLICATE_CHARGE_REFUND", [{ text: "$5,000.00", amountMinor: 500000, currency: "USD" }]),
        escalate,
        "ESCALATED",
      ],
    ] as const;
    for (const [request, understanding, decision, expected] of cases) {
      const { c } = await run(request, understanding, decision);
      assert.equal(c.state, expected, `${request.orderId}: ${reasonDetails(c)}`);
    }
  });
});
