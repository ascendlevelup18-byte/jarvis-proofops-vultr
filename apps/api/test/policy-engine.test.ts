import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DecisionProposalSchema,
  type CaseRequest,
  type CustomerIntent,
  type EvidenceBundle,
  type StructuredRequest,
} from "../src/contracts.ts";
import { gatherEvidence } from "../src/evidence.ts";
import { CommerceStore, REFUND_POLICY, SCENARIOS, seedFixtures } from "../src/fixtures.ts";
import { findMoneyMentions } from "../src/money.ts";
import { authorize } from "../src/policy-engine.ts";
import { classifyIntent } from "../src/request-understanding.ts";
import { NOW, proposal } from "./helpers.ts";

const understand = (req: CaseRequest, intent?: CustomerIntent): StructuredRequest => ({
  intent: intent ?? classifyIntent(req.message),
  mentionedAmounts: findMoneyMentions(req.message),
});

function evidence(req: CaseRequest, opts: { intent?: CustomerIntent; store?: CommerceStore } = {}): EvidenceBundle {
  const store = opts.store ?? new CommerceStore();
  if (!opts.store) seedFixtures(store, NOW);
  const r = gatherEvidence(req, understand(req, opts.intent), store, REFUND_POLICY);
  if (!r.ok) throw new Error(r.reason.detail);
  return r.evidence;
}
const p = (over: Record<string, unknown> = {}) => DecisionProposalSchema.parse(JSON.parse(proposal(over)));
const NONE = { action: "NO_ACTION", refundTransactionId: null, keepTransactionId: null, evidenceRefs: [] };
const failedRules = (req: CaseRequest, ev: EvidenceBundle, over: Record<string, unknown> = {}, autoRefund = true) =>
  authorize(p(over), ev, req, { autoRefund })
    .checks.filter((c) => !c.passed)
    .map((c) => c.rule);
const failed = (req: CaseRequest, over: Record<string, unknown> = {}, autoRefund = true) =>
  failedRules(req, evidence(req), over, autoRefund);

const valid = SCENARIOS.validDuplicate;

test("approves a verified duplicate; amount is derived from the transaction record", () => {
  const d = authorize(p(), evidence(valid), valid, { autoRefund: true });
  assert.equal(d.outcome, "APPROVE");
  assert.ok(d.checks.every((c) => c.passed));
  assert.deepEqual(d.action, {
    transactionId: "CHARGE-48291-B",
    amountMinor: 8999,
    currency: "USD",
    idempotencyKey: "jarvis-dup-refund:48291",
  });
});

test("model cannot supply money: amount fields are rejected by the schema", () => {
  assert.equal(DecisionProposalSchema.safeParse({ ...JSON.parse(proposal()), refundAmountMinor: 500000 }).success, false);
  assert.equal(DecisionProposalSchema.safeParse({ ...JSON.parse(proposal()), verified: true }).success, false);
});

test("conflicting amount blocks", () => {
  const req = SCENARIOS.conflictingAmount;
  assert.deepEqual(
    failed(req, { refundTransactionId: "CHARGE-48292-B", keepTransactionId: "CHARGE-48292-A", evidenceRefs: [] }),
    ["NO_CONTRADICTIONS"],
  );
});

test("already-refunded charge: refund blocked, verified no-action allowed", () => {
  const req = SCENARIOS.alreadyRefunded;
  assert.deepEqual(
    failed(req, { refundTransactionId: "CHARGE-48293-B", keepTransactionId: "CHARGE-48293-A", evidenceRefs: [] }),
    ["NOT_ALREADY_REFUNDED", "WITHIN_AUTHORITY"],
  );
  const d = authorize(p(NONE), evidence(req), req, { autoRefund: true });
  assert.equal(d.outcome, "NO_ACTION");
  assert.ok(d.checks.some((c) => c.rule === "ORDER_PAID_EXACTLY_ONCE" && c.passed));
});

test("currency mismatch blocks", () => {
  const req = { ...valid, message: "charged twice, €89.99" };
  assert.deepEqual(failed(req), ["CURRENCY_CONSISTENT", "NO_CONTRADICTIONS"]);
});

test("unsupported or missing currency on a stated amount blocks", () => {
  assert.deepEqual(failed({ ...valid, message: "I was charged CAD 89.99 twice" }), ["CURRENCY_CONSISTENT", "NO_CONTRADICTIONS"]);
  assert.deepEqual(failed({ ...valid, message: "I was charged twice, refund 89.99 please" }), ["NO_CONTRADICTIONS"]);
});

test("unsupported intent blocks both refund and no-action", () => {
  for (const intent of ["FULL_ORDER_CANCELLATION", "GENERAL_REFUND", "UNKNOWN", "OTHER"] as const) {
    assert.deepEqual(failedRules(valid, evidence(valid, { intent })), ["INTENT_SUPPORTED"], intent);
    const ev = evidence(SCENARIOS.alreadyRefunded, { intent });
    assert.equal(authorize(p(NONE), ev, SCENARIOS.alreadyRefunded, { autoRefund: true }).outcome, "DENY", intent);
  }
});

test("no-action is denied when payment evidence is missing, pending or the order is overpaid", () => {
  const store = new CommerceStore();
  store.addCustomer({ id: "CUST-1", name: "T" });
  const order = (id: string, totalMinor: number) =>
    store.addOrder({ id, customerId: "CUST-1", totalMinor, currency: "USD", createdAt: NOW.toISOString() });
  const tx = (id: string, orderId: string, status: "SUCCEEDED" | "PENDING", minutesAgo: number) =>
    store.addTransaction({
      id,
      orderId,
      customerId: "CUST-1",
      amountMinor: 1000,
      currency: "USD",
      status,
      refundedMinor: 0,
      createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    });
  order("NONE", 1000);
  order("PEND", 1000);
  tx("P-1", "PEND", "SUCCEEDED", 100);
  tx("P-2", "PEND", "PENDING", 99);
  order("OVER", 1000);
  tx("O-1", "OVER", "SUCCEEDED", 100);
  tx("O-2", "OVER", "SUCCEEDED", 50); // outside the 10-minute duplicate window

  const run = (orderId: string) => {
    const req = { customerId: "CUST-1", orderId, message: "I was charged twice" };
    return failedRules(req, evidence(req, { store }), NONE);
  };
  assert.deepEqual(run("NONE"), ["PAYMENT_RECORDS_PRESENT", "ORDER_PAID_EXACTLY_ONCE"]);
  assert.deepEqual(run("PEND"), ["PAYMENT_STATES_FINAL"]);
  assert.deepEqual(run("OVER"), ["ORDER_PAID_EXACTLY_ONCE"]);
});

test("hallucinated or cross-order transaction ids block", () => {
  assert.deepEqual(failed(valid, { refundTransactionId: "CHARGE-48294-B" }), ["TRANSACTIONS_IN_EVIDENCE"]);
  assert.deepEqual(failed(valid, { keepTransactionId: "CHARGE-48291-B" }), ["TRANSACTIONS_IN_EVIDENCE"]);
  assert.deepEqual(failed(valid, { evidenceRefs: ["POL-EVIL"] }), ["EVIDENCE_REFS_VALID"]);
});

test("model risk flags, low confidence and disabled permission block", () => {
  assert.deepEqual(failed(valid, { riskFlags: ["unsure"] }), ["NO_MODEL_RISK_FLAGS"]);
  assert.deepEqual(failed(valid, { confidence: 0.2 }), ["MODEL_CONFIDENCE"]);
  assert.deepEqual(failed(valid, {}, false), ["REFUND_PERMITTED"]);
});

test("ESCALATE is always a denial; NO_ACTION denied while the customer is overcharged", () => {
  const nulls = { refundTransactionId: null, keepTransactionId: null };
  assert.equal(authorize(p({ action: "ESCALATE", ...nulls }), evidence(valid), valid, { autoRefund: true }).outcome, "DENY");
  assert.equal(authorize(p(NONE), evidence(valid), valid, { autoRefund: true }).outcome, "DENY");
});

test("money mentions: symbols, codes, bare amounts; order references ignored", () => {
  const got = (s: string) => findMoneyMentions(s).map((m) => [m.amountMinor, m.currency]);
  assert.deepEqual(got("order #48291: refund $5,000.00 or 250 eur, not 48291"), [
    [500000, "USD"],
    [25000, "EUR"],
  ]);
  assert.deepEqual(got("Charged twice on order 50208, refund 250 please."), [[25000, null]]);
  assert.deepEqual(got("I was charged CAD 89.99 twice"), [[8999, "CAD"]]);
  assert.deepEqual(got("I was charged twice for order #48291."), []);
  assert.deepEqual(got("Order #50103 was charged $64.50 two times."), [[6450, "USD"]]);
});

test("fixture intent classification", () => {
  assert.equal(classifyIntent("I was charged twice for order #48291."), "DUPLICATE_CHARGE_REFUND");
  assert.equal(classifyIntent("I was charged €42.00 twice"), "DUPLICATE_CHARGE_REFUND");
  assert.equal(classifyIntent("charged twice. Cancel the whole order and give me everything back."), "FULL_ORDER_CANCELLATION");
  assert.equal(classifyIntent("I want a full refund"), "GENERAL_REFUND");
  assert.equal(classifyIntent("Payment issue."), "UNKNOWN");
});
