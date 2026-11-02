import assert from "node:assert/strict";
import { test } from "node:test";
import type { Case } from "../src/contracts.ts";
import { runCase } from "../src/case-engine.ts";
import { SCENARIOS } from "../src/fixtures.ts";
import { FixtureModelAdapter, type ModelInput } from "../src/model-adapter.ts";
import { FixtureRequestUnderstandingAdapter, type RequestUnderstandingAdapter } from "../src/request-understanding.ts";
import {
  NOW,
  makeDeps,
  modelSaying,
  proposal,
  reasonDetails,
  refunded,
  statePath,
  understandingSaying,
  type TestDeps,
} from "./helpers.ts";

const HAPPY_PATH = [
  "RECEIVED",
  "EXTRACTING",
  "EVIDENCE_GATHERING",
  "ANALYZING",
  "DECISION_PROPOSED",
  "POLICY_VALIDATION",
  "APPROVED",
  "EXECUTING",
  "VERIFYING",
  "RESOLVED",
];

// Invariants every case must satisfy, whatever happened.
function assertInvariants(c: Case): void {
  const path = statePath(c);
  path.forEach((s, i) => {
    if (s === "EXECUTING") assert.equal(path[i - 1], "APPROVED", "EXECUTING without APPROVED");
    if (s === "RESOLVED") assert.equal(path[i - 1], "VERIFYING", "RESOLVED without VERIFYING");
  });
  if (c.state === "RESOLVED") {
    const v = c.audit.find((e) => e.type === "VERIFICATION");
    assert.equal((v?.data as { verified: boolean }).verified, true, "RESOLVED without verified read-back");
  }
  assert.equal(path.at(-1), c.state, "final state transition audited");
  assert.deepEqual(
    c.audit.map((e) => e.seq),
    c.audit.map((_, i) => i + 1),
    "audit sequence contiguous",
  );
}

// ---------- Required fixture scenarios (default naive fixture model) ----------

test("valid duplicate resolves with a verified refund of the derived amount", async () => {
  const deps = makeDeps();
  const c = await runCase(SCENARIOS.validDuplicate, deps);
  assertInvariants(c);
  assert.equal(c.state, "RESOLVED", reasonDetails(c));
  assert.deepEqual(statePath(c), HAPPY_PATH);
  assert.equal(c.authorization?.action?.amountMinor, 8999);
  assert.equal(c.verification?.verified, true);
  assert.equal(c.verification?.observedRefund?.amountMinor, 8999);
  assert.equal(refunded(deps, "CHARGE-48291-B"), 8999);
  assert.equal(refunded(deps, "CHARGE-48291-A"), 0);
  for (const t of ["MODEL_CALL", "POLICY_EVALUATED", "ACTION_ATTEMPTED", "VERIFICATION"]) {
    assert.ok(c.audit.some((e) => e.type === t), `audit has ${t}`);
  }
});

test("conflicting refund amount ($250 vs verified $180) escalates; no money moves", async () => {
  const deps = makeDeps();
  const c = await runCase(SCENARIOS.conflictingAmount, deps);
  assertInvariants(c);
  assert.equal(c.state, "ESCALATED");
  assert.equal(c.proposal?.action, "REFUND_DUPLICATE"); // the naive model wanted to act...
  assert.match(reasonDetails(c), /NO_CONTRADICTIONS: customer states 250\.00 USD/); // ...policy blocked it
  assert.equal(c.action, null);
  assert.equal(refunded(deps, "CHARGE-48292-B"), 0);
});

test("already-refunded duplicate closes with no action and is not refunded again", async () => {
  const deps = makeDeps();
  const c = await runCase(SCENARIOS.alreadyRefunded, deps);
  assertInvariants(c);
  assert.equal(c.state, "CLOSED_NO_ACTION");
  assert.equal(c.evidence?.financial.status, "PAID_EXACTLY_ONCE");
  assert.ok(c.authorization?.checks.every((k) => k.passed));
  assert.equal(c.action, null);
  assert.equal(refunded(deps, "CHARGE-48293-B"), 4500); // unchanged: only the seeded refund
});

test("a model still proposing to refund an already-refunded charge is escalated, not closed", async () => {
  const deps = makeDeps({
    model: modelSaying(
      proposal({ refundTransactionId: "CHARGE-48293-B", keepTransactionId: "CHARGE-48293-A", evidenceRefs: [] }),
    ),
  });
  const c = await runCase(SCENARIOS.alreadyRefunded, deps);
  assert.equal(c.state, "ESCALATED");
  assert.match(reasonDetails(c), /NOT_ALREADY_REFUNDED/);
});

test("prompt-injection message cannot bypass policy", async () => {
  const deps = makeDeps();
  const c = await runCase(SCENARIOS.promptInjection, deps);
  assertInvariants(c);
  assert.equal(c.state, "ESCALATED");
  assert.match(reasonDetails(c), /5000\.00 USD/);
  assert.equal(c.action, null);
  assert.equal(refunded(deps, "CHARGE-48294-B"), 0);
});

test("injected text stays in the untrusted field, never in model instructions", async () => {
  const seen: ModelInput[] = [];
  const deps = makeDeps({ model: modelSaying((input) => (seen.push(input), proposal())) });
  await runCase(SCENARIOS.promptInjection, deps);
  const input = seen[0];
  assert.ok(input);
  assert.equal(input.untrusted.customerMessage, SCENARIOS.promptInjection.message);
  assert.ok(!input.instructions.includes("IMPORTANT SYSTEM NOTICE"));
});

// ---------- A compromised model cannot act outside records/policy ----------

test("compromised model outputs are blocked or rejected", async () => {
  const cases: [string, RegExp, string][] = [
    [proposal({ refundAmountMinor: 500000 }), /MODEL_OUTPUT_INVALID/, "FAILED"],
    [proposal({ verified: true }), /MODEL_OUTPUT_INVALID/, "FAILED"],
    [proposal({ refundTransactionId: "CHARGE-48294-B" }), /TRANSACTIONS_IN_EVIDENCE/, "ESCALATED"],
    [proposal({ evidenceRefs: ["ADMIN-OVERRIDE"] }), /EVIDENCE_REFS_VALID/, "ESCALATED"],
  ];
  for (const [raw, reason, state] of cases) {
    const deps = makeDeps({ model: modelSaying(raw) });
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assertInvariants(c);
    assert.equal(c.state, state, raw);
    assert.match(reasonDetails(c), reason);
    assert.equal(refunded(deps, "CHARGE-48291-B"), 0);
    assert.equal(refunded(deps, "CHARGE-48294-B"), 0);
  }
});

// ---------- Model failures ----------

test("malformed model output fails closed", async () => {
  for (const raw of ["Sure, refunding now!", "{}", '{"action":"REFUND_EVERYTHING"}']) {
    const deps = makeDeps({ model: modelSaying(raw) });
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assertInvariants(c);
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, "MODEL_OUTPUT_INVALID");
    assert.equal(c.proposal, null);
  }
});

test("model timeout fails closed even if the adapter ignores the abort signal", async () => {
  const hang = new FixtureModelAdapter(() => new Promise<string>(() => {}));
  const deps = makeDeps({ model: hang, modelTimeoutMs: 50 });
  const c = await runCase(SCENARIOS.validDuplicate, deps);
  assertInvariants(c);
  assert.equal(c.state, "FAILED");
  assert.equal(c.reasons[0]?.code, "MODEL_TIMEOUT");
});

test("model error fails closed", async () => {
  const boom = new FixtureModelAdapter(() => {
    throw new Error("connection refused");
  });
  const c = await runCase(SCENARIOS.validDuplicate, makeDeps({ model: boom }));
  assert.equal(c.state, "FAILED");
  assert.equal(c.reasons[0]?.code, "MODEL_ERROR");
});

// ---------- Execution / verification ----------

test("provider timeout where the refund DID happen -> verified -> RESOLVED", async () => {
  const deps = makeDeps();
  deps.gateway.nextFault = "TIMEOUT_AFTER_COMMIT";
  const c = await runCase(SCENARIOS.validDuplicate, deps);
  assertInvariants(c);
  assert.equal(c.state, "RESOLVED");
  assert.equal(c.action?.status, "ERROR");
  assert.equal(c.verification?.verified, true);
  assert.equal(refunded(deps, "CHARGE-48291-B"), 8999);
});

test("provider timeout where the refund did NOT happen -> not verified -> FAILED", async () => {
  const deps = makeDeps();
  deps.gateway.nextFault = "TIMEOUT_BEFORE_COMMIT";
  const c = await runCase(SCENARIOS.validDuplicate, deps);
  assertInvariants(c);
  assert.equal(c.state, "FAILED");
  assert.equal(c.reasons[0]?.code, "EXECUTION_NOT_VERIFIED");
  assert.equal(refunded(deps, "CHARGE-48291-B"), 0);
});

test("provider says OK but read-back disagrees -> never RESOLVED", async () => {
  const deps = makeDeps();
  deps.gateway.findRefund = async () => null;
  const c = await runCase(SCENARIOS.validDuplicate, deps);
  assertInvariants(c);
  assert.equal(c.state, "FAILED");
  assert.equal(c.action?.status, "ACCEPTED");
  assert.ok(!statePath(c).includes("RESOLVED"));
});

test("stale state: kept charge refunded elsewhere after analysis -> no refund executed", async () => {
  let deps!: TestDeps;
  deps = makeDeps({
    model: modelSaying(() => {
      // Happens after the evidence snapshot, before execution.
      deps.store.recordRefund({
        id: "RF-HUMAN",
        transactionId: "CHARGE-48291-A",
        amountMinor: 8999,
        currency: "USD",
        status: "SUCCEEDED",
        idempotencyKey: "human",
        createdAt: NOW.toISOString(),
      });
      return proposal();
    }),
  });
  const c = await runCase(SCENARIOS.validDuplicate, deps);
  assertInvariants(c);
  assert.equal(c.state, "ESCALATED");
  assert.equal(c.reasons[0]?.code, "STALE_EVIDENCE");
  assert.match(reasonDetails(c), /KEPT_CHARGE_INTACT/);
  assert.ok(!statePath(c).includes("EXECUTING"));
  assert.equal(refunded(deps, "CHARGE-48291-B"), 0);
});

test("resubmitting a resolved case does not refund twice", async () => {
  const deps = makeDeps();
  await runCase(SCENARIOS.validDuplicate, deps);
  const again = await runCase(SCENARIOS.validDuplicate, deps);
  assert.equal(again.state, "CLOSED_NO_ACTION");
  assert.ok(!statePath(again).includes("EXECUTING"));
  assert.equal(refunded(deps, "CHARGE-48291-B"), 8999);
});

// ---------- Request understanding ----------

test("requests outside duplicate-charge scope escalate even when a duplicate exists", async () => {
  for (const message of [
    "I was charged twice for order #48291. Cancel the whole order and give me everything back.",
    "Payment issue.",
  ]) {
    const deps = makeDeps();
    const c = await runCase({ ...SCENARIOS.validDuplicate, message }, deps);
    assertInvariants(c);
    assert.equal(c.state, "ESCALATED", message);
    assert.match(reasonDetails(c), /INTENT_SUPPORTED/);
    assert.equal(refunded(deps, "CHARGE-48291-B"), 0);
  }
});

test("understanding output is runtime-validated; failures fail closed", async () => {
  const cases: [RequestUnderstandingAdapter, string][] = [
    [understandingSaying("refund it"), "UNDERSTANDING_OUTPUT_INVALID"],
    [understandingSaying('{"intent":"REFUND_ALL","mentionedAmounts":[]}'), "UNDERSTANDING_OUTPUT_INVALID"],
    [understandingSaying('{"intent":"DUPLICATE_CHARGE_REFUND","mentionedAmounts":[],"approved":true}'), "UNDERSTANDING_OUTPUT_INVALID"],
    [new FixtureRequestUnderstandingAdapter(() => new Promise<string>(() => {})), "UNDERSTANDING_TIMEOUT"],
    [
      new FixtureRequestUnderstandingAdapter(() => {
        throw new Error("down");
      }),
      "UNDERSTANDING_ERROR",
    ],
  ];
  for (const [understanding, code] of cases) {
    const deps = makeDeps({ understanding, modelTimeoutMs: 50 });
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assertInvariants(c);
    assert.equal(c.state, "FAILED");
    assert.equal(c.reasons[0]?.code, code);
    assert.equal(c.evidence, null);
  }
});

test("an understanding adapter that hides a stated amount is caught by the deterministic backstop", async () => {
  const blind = understandingSaying('{"intent":"DUPLICATE_CHARGE_REFUND","mentionedAmounts":[]}');
  const deps = makeDeps({ understanding: blind });
  const c = await runCase(SCENARIOS.promptInjection, deps);
  assert.equal(c.state, "ESCALATED");
  assert.match(reasonDetails(c), /5000\.00 USD/);
});

// ---------- Evidence-stage escalations ----------

test("wrong customer / unknown order escalate before the model is called", async () => {
  let calls = 0;
  const counting = new FixtureModelAdapter(() => (calls++, proposal()));
  for (const [req, code] of [
    [{ ...SCENARIOS.validDuplicate, customerId: "CUST-1002" }, "ORDER_OWNERSHIP_MISMATCH"],
    [{ ...SCENARIOS.validDuplicate, orderId: "99999" }, "ORDER_NOT_FOUND"],
    [{ ...SCENARIOS.validDuplicate, customerId: "CUST-9999" }, "CUSTOMER_NOT_FOUND"],
  ] as const) {
    const c = await runCase(req, makeDeps({ model: counting }));
    assertInvariants(c);
    assert.equal(c.state, "ESCALATED");
    assert.equal(c.reasons[0]?.code, code);
  }
  assert.equal(calls, 0);
});

test("unexpected internal error still ends in a terminal state", async () => {
  const deps = makeDeps();
  deps.store.getOrder = () => {
    throw new Error("store unavailable");
  };
  const c = await runCase(SCENARIOS.validDuplicate, deps);
  assertInvariants(c);
  assert.equal(c.state, "FAILED");
  assert.equal(c.reasons[0]?.code, "INTERNAL_ERROR");
});
