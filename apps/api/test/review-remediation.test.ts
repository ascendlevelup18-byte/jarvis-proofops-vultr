// Regression tests for the P0/P1 findings of the pre-UI engineering review (HEAD 2537584).
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DecisionProposalSchema,
  type CaseRequest,
  type EvidenceBundle,
  type PaymentTransaction,
  type Refund,
} from "../src/contracts.ts";
import { runCase, type EngineDeps } from "../src/case-engine.ts";
import { findOrderReferences, gatherEvidence } from "../src/evidence.ts";
import { CommerceStore, REFUND_POLICY, SCENARIOS } from "../src/fixtures.ts";
import type { PaymentGateway } from "../src/gateway.ts";
import { findIntentCues } from "../src/intent-cues.ts";
import { findMoneyMentions } from "../src/money.ts";
import { authorize } from "../src/policy-engine.ts";
import { classifyIntent } from "../src/request-understanding.ts";
import { NOW, makeDeps, modelSaying, proposal, reasonDetails, refunded, statePath, understandingSaying } from "./helpers.ts";

// ---------- helpers: small isolated worlds ----------

const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

function world(totalMinor: number, charges: { id: string; amountMinor?: number; minutesAgo: number }[]): CommerceStore {
  const store = new CommerceStore();
  store.addCustomer({ id: "CUST-7", name: "Test" });
  store.addOrder({ id: "7001", customerId: "CUST-7", totalMinor, currency: "USD", createdAt: at(200) });
  for (const c of charges) store.addTransaction(tx(c.id, c.amountMinor ?? totalMinor, c.minutesAgo));
  return store;
}
const tx = (id: string, amountMinor: number, minutesAgo: number, refundedMinor = 0): PaymentTransaction => ({
  id,
  orderId: "7001",
  customerId: "CUST-7",
  amountMinor,
  currency: "USD",
  status: "SUCCEEDED",
  refundedMinor,
  createdAt: at(minutesAgo),
});
const refundRecord = (transactionId: string, amountMinor: number): Refund => ({
  id: `RF-${transactionId}`,
  transactionId,
  amountMinor,
  currency: "USD",
  status: "SUCCEEDED",
  idempotencyKey: `test-${transactionId}`,
  createdAt: at(10),
});
const req7 = (message = "I was charged twice for order 7001"): CaseRequest => ({ customerId: "CUST-7", orderId: "7001", message });

function evidenceIn(store: CommerceStore, req: CaseRequest): EvidenceBundle {
  const r = gatherEvidence(
    req,
    { intent: classifyIntent(req.message), mentionedAmounts: findMoneyMentions(req.message) },
    store,
    REFUND_POLICY,
  );
  if (!r.ok) throw new Error(r.reason.detail);
  return r.evidence;
}
const failedRules = (ev: EvidenceBundle, req: CaseRequest, over: Record<string, unknown>) =>
  authorize(DecisionProposalSchema.parse(JSON.parse(proposal({ evidenceRefs: [], ...over }))), ev, req, { autoRefund: true })
    .checks.filter((c) => !c.passed)
    .map((c) => c.rule);

// ---------- P0-1: concurrent cases on one order ----------

test("P0-1: concurrent cases refunding different duplicate charges cannot both move money", async () => {
  const deps = makeDeps();
  const inner = deps.gateway;
  // Real-provider-like: the commit happens after an await, so both cases pass revalidation first.
  const asyncGateway: PaymentGateway = {
    refund: async (a) => {
      await sleep(20);
      return inner.refund(a);
    },
    findRefund: (k) => inner.findRefund(k),
  };
  const d1: EngineDeps = { ...deps, gateway: asyncGateway, model: modelSaying(proposal()) }; // refund B, keep A
  const d2: EngineDeps = {
    ...deps,
    gateway: asyncGateway,
    model: modelSaying(proposal({ refundTransactionId: "CHARGE-48291-A", keepTransactionId: "CHARGE-48291-B" })),
  };
  const [a, b] = await Promise.all([runCase(SCENARIOS.validDuplicate, d1), runCase(SCENARIOS.validDuplicate, d2)]);

  // The race is genuinely reproduced: both cases were approved and reached execution.
  assert.ok(statePath(a).includes("EXECUTING") && statePath(b).includes("EXECUTING"));
  // At most one corrective refund succeeds.
  assert.equal(deps.store.refundsForTransactions(["CHARGE-48291-A", "CHARGE-48291-B"]).length, 1);
  assert.equal(refunded(deps, "CHARGE-48291-A")! + refunded(deps, "CHARGE-48291-B")!, 8999);
  // One case resolves; the other fails safely to a human.
  assert.deepEqual([a.state, b.state].sort(), ["FAILED", "RESOLVED"]);
  const loser = a.state === "FAILED" ? a : b;
  assert.equal(loser.reasons[0]?.code, "EXECUTION_NOT_VERIFIED");
});

// ---------- P0-2: deterministic intent backstop ----------

test("P0-2: a mislabelling understanding adapter cannot unlock an autonomous refund", async () => {
  const lying = understandingSaying('{"intent":"DUPLICATE_CHARGE_REFUND","mentionedAmounts":[]}');
  for (const message of [
    "I was charged twice for order #48291. Cancel the whole order and give me everything back.",
    "I was charged twice for order #48291, I want a full refund.",
    "Payment issue.",
  ]) {
    const deps = makeDeps({ understanding: lying });
    const c = await runCase({ ...SCENARIOS.validDuplicate, message }, deps);
    assert.equal(c.state, "ESCALATED", message);
    assert.match(reasonDetails(c), /INTENT_CORROBORATED/, message);
    assert.equal(c.action, null);
    assert.equal(refunded(deps, "CHARGE-48291-B"), 0);
  }
});

test("P0-2: the same adapter on a genuine duplicate complaint still resolves", async () => {
  const deps = makeDeps({ understanding: understandingSaying('{"intent":"DUPLICATE_CHARGE_REFUND","mentionedAmounts":[]}') });
  const c = await runCase(SCENARIOS.validDuplicate, deps);
  assert.equal(c.state, "RESOLVED");
});

test("P0-2: deterministic intent cues", () => {
  const cues = (s: string) => findIntentCues(s);
  assert.deepEqual(cues("I was charged twice for order #1"), { duplicateCharge: true, outOfScope: [] });
  assert.deepEqual(cues("My statement shows two payments, was I double charged?"), { duplicateCharge: true, outOfScope: [] });
  assert.equal(cues("Payment issue.").duplicateCharge, false);
  assert.ok(cues("charged twice, please cancel my order").outOfScope.length > 0);
  assert.ok(cues("charged twice. Cancel the whole order").outOfScope.length > 0);
  assert.ok(cues("charged twice, I want a full refund").outOfScope.length > 0);
  assert.ok(cues("charged twice, refund everything").outOfScope.length > 0);
});

// ---------- P1-1: order-reference contradiction ----------

test("P1-1: explicit order references are extracted; other numbers are not", () => {
  assert.deepEqual(findOrderReferences("I was charged twice for order #48291."), ["48291"]);
  assert.deepEqual(findOrderReferences("Order 50102 and order no. 50103, also #50104"), ["50102", "50103", "50104"]);
  assert.deepEqual(findOrderReferences("refund $250 or 250 EUR, 2 days ago, order of 3 items, 89.99"), []);
  assert.deepEqual(findOrderReferences("Payment issue."), []);
});

test("P1-1: a message naming a different order cannot be acted on", async () => {
  const deps = makeDeps();
  const c = await runCase({ customerId: "CUST-1001", orderId: "48291", message: "I was charged twice for order #48292." }, deps);
  assert.equal(c.state, "ESCALATED");
  assert.match(reasonDetails(c), /NO_CONTRADICTIONS: .*48292/);
  assert.equal(refunded(deps, "CHARGE-48291-B"), 0);
  // Matching reference (incl. '#'-prefixed orderId field) is fine.
  const ok = await runCase({ customerId: "CUST-1001", orderId: "#48291", message: "I was charged twice for order #48291." }, makeDeps());
  assert.equal(ok.state, "RESOLVED");
});

// ---------- P1-2: refund-ledger coherence ----------

test("P1-2: refund ledger must agree with transaction refundedMinor", () => {
  // Ledger smaller: transaction claims a refund with no record.
  const smaller = world(1000, []);
  smaller.addTransaction(tx("T-A", 1000, 100));
  smaller.addTransaction(tx("T-B", 1000, 99, 1000));
  assert.ok(evidenceIn(smaller, req7()).contradictions.some((c) => c.includes("T-B") && c.includes("ledger")));

  // Ledger larger: a refund record exists but the transaction shows nothing refunded.
  const larger = world(1000, [
    { id: "T-A", minutesAgo: 100 },
    { id: "T-B", minutesAgo: 99 },
  ]);
  larger.recordRefund(refundRecord("T-B", 1000));
  larger.addTransaction(tx("T-B", 1000, 99, 0)); // overwrite: transaction no longer reflects the record
  assert.ok(evidenceIn(larger, req7()).contradictions.some((c) => c.includes("T-B") && c.includes("ledger")));

  // Coherent ledger: no contradiction.
  const coherent = world(1000, [
    { id: "T-A", minutesAgo: 100 },
    { id: "T-B", minutesAgo: 99 },
  ]);
  coherent.recordRefund(refundRecord("T-B", 1000));
  assert.deepEqual(evidenceIn(coherent, req7()).contradictions, []);
});

test("P1-2: an incoherent ledger cannot be closed autonomously", async () => {
  const store = world(1000, []);
  store.addTransaction(tx("T-A", 1000, 100));
  store.addTransaction(tx("T-B", 1000, 99, 1000)); // looks already refunded, but no record exists
  const deps = { ...makeDeps(), store };
  const c = await runCase(req7(), deps);
  assert.equal(c.state, "ESCALATED");
  assert.match(reasonDetails(c), /NO_CONTRADICTIONS: .*ledger/);
});

// ---------- P1-3: previously unexercised load-bearing guards ----------

test("P1-3: DUPLICATE_VERIFIED rejects a refund of same-amount charges outside the duplicate window", () => {
  const store = world(1000, [
    { id: "T-A", minutesAgo: 100 },
    { id: "T-B", minutesAgo: 50 }, // 50 min apart > 10 min window; order is overpaid
  ]);
  const ev = evidenceIn(store, req7());
  assert.deepEqual(ev.duplicateGroups, []);
  assert.deepEqual(failedRules(ev, req7(), { refundTransactionId: "T-B", keepTransactionId: "T-A" }), ["DUPLICATE_VERIFIED"]);
});

test("P1-3: WITHIN_AUTHORITY rejects a verified duplicate above the autonomous limit", () => {
  const store = world(60_000, [
    { id: "T-A", minutesAgo: 100 },
    { id: "T-B", minutesAgo: 99 },
  ]);
  const ev = evidenceIn(store, req7());
  assert.deepEqual(failedRules(ev, req7(), { refundTransactionId: "T-B", keepTransactionId: "T-A" }), ["WITHIN_AUTHORITY"]);
});
