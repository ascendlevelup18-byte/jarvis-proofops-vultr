import assert from "node:assert/strict";
import { test } from "node:test";
import { CASE_STATES, type Case } from "../src/contracts.ts";
import { TRANSITIONS, assertTransition, isTerminal } from "../src/state-machine.ts";

const blank = (over: Partial<Case>): Case => ({
  id: "C",
  request: { customerId: "CUST-1", orderId: "1", message: "x" },
  state: "RECEIVED",
  createdAt: "",
  updatedAt: "",
  understanding: null,
  evidence: null,
  proposal: null,
  authorization: null,
  action: null,
  verification: null,
  reasons: [],
  audit: [],
  ...over,
});

test("EXECUTING is reachable only from APPROVED; RESOLVED only from VERIFYING", () => {
  const into = (target: string) => CASE_STATES.filter((s) => TRANSITIONS[s].includes(target as never));
  assert.deepEqual(into("EXECUTING"), ["APPROVED"]);
  assert.deepEqual(into("RESOLVED"), ["VERIFYING"]);
  assert.deepEqual(into("APPROVED"), ["POLICY_VALIDATION"]);
});

test("terminal states have no exits; every non-terminal state can fail safely", () => {
  for (const s of ["RESOLVED", "ESCALATED", "FAILED", "CLOSED_NO_ACTION"] as const) assert.ok(isTerminal(s));
  for (const s of CASE_STATES) if (!isTerminal(s)) assert.ok(TRANSITIONS[s].includes("FAILED"), s);
});

test("guards: illegal edges and missing preconditions throw", () => {
  assert.throws(() => assertTransition(blank({ state: "RECEIVED" }), "RESOLVED"), /illegal transition/);
  assert.throws(() => assertTransition(blank({ state: "RESOLVED" }), "FAILED"), /illegal transition/);
  assert.throws(() => assertTransition(blank({ state: "APPROVED" }), "EXECUTING"), /requires an APPROVE/);
  assert.throws(() => assertTransition(blank({ state: "POLICY_VALIDATION" }), "APPROVED"), /requires an APPROVE/);
  assert.throws(
    () => assertTransition(blank({ state: "VERIFYING", verification: { verified: false, observedRefund: null, detail: "" } }), "RESOLVED"),
    /requires successful verification/,
  );
  assert.throws(() => assertTransition(blank({ state: "POLICY_VALIDATION" }), "CLOSED_NO_ACTION"), /NO_ACTION/);
});

test("replayed refunds: close only after a verified replay, and never resolve", () => {
  const approve = { outcome: "APPROVE" as const, checks: [], action: { transactionId: "T", amountMinor: 1, currency: "USD" as const, idempotencyKey: "k" } };
  const accepted = (replayed: boolean) => ({ status: "ACCEPTED" as const, providerRefundId: "RF-1", replayed, error: null, attemptedAt: "" });
  const verified = { verified: true, observedRefund: null, detail: "" };
  const at = (replayed: boolean, v = verified) => blank({ state: "VERIFYING", authorization: approve, action: accepted(replayed), verification: v });

  assert.doesNotThrow(() => assertTransition(at(true), "CLOSED_NO_ACTION"));
  assert.throws(() => assertTransition(at(true), "RESOLVED"), /replayed refund cannot resolve/);
  assert.throws(() => assertTransition(at(false), "CLOSED_NO_ACTION"), /verified replayed refund/);
  assert.throws(() => assertTransition(at(true, { ...verified, verified: false }), "CLOSED_NO_ACTION"), /verified replayed refund/);
  assert.doesNotThrow(() => assertTransition(at(false), "RESOLVED"));
});
