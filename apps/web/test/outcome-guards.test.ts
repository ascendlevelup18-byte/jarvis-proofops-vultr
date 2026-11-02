import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Case, CaseState } from "../src/lib/case-types.ts";
import { deriveVerdict } from "../src/lib/verdict.ts";
import {
  executionGateLocked,
  outcomeKind,
  presentsAsSuccessfulRefund,
  presentsFalseSuccess,
} from "../src/lib/outcome-guards.ts";

function baseCase(overrides: Partial<Case> & { state: CaseState }): Case {
  return {
    id: "CASE-TEST",
    request: { customerId: "CUST-1", orderId: "1", message: "test" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    understanding: null,
    evidence: null,
    proposal: null,
    authorization: null,
    action: null,
    verification: null,
    reasons: [],
    audit: [],
    ...overrides,
  };
}

describe("outcome presentation guards", () => {
  it("RESOLVED presents success only when state is RESOLVED", () => {
    const c = baseCase({
      state: "RESOLVED",
      authorization: {
        outcome: "APPROVE",
        checks: [{ rule: "X", passed: true, detail: "ok" }],
        action: {
          transactionId: "PAY-1",
          amountMinor: 100,
          currency: "USD",
          idempotencyKey: "k",
        },
      },
      action: {
        status: "ACCEPTED",
        providerRefundId: "RF-1",
        error: null,
        attemptedAt: "2026-01-01T00:00:00.000Z",
      },
      verification: {
        verified: true,
        observedRefund: {
          id: "RF-1",
          transactionId: "PAY-1",
          amountMinor: 100,
          currency: "USD",
          status: "SUCCEEDED",
        },
        detail: "ok",
      },
      audit: [
        {
          seq: 1,
          caseId: "CASE-TEST",
          at: "2026-01-01T00:00:00.000Z",
          type: "STATE_TRANSITION",
          from: "VERIFYING",
          to: "RESOLVED",
          data: {},
        },
      ],
    });
    assert.equal(outcomeKind(c), "RESOLVED");
    assert.equal(presentsAsSuccessfulRefund(c), true);
    assert.equal(presentsFalseSuccess(c), false);
    assert.match(deriveVerdict(c).headline, /RESOLVED/);
  });

  it("ESCALATED never presents false success", () => {
    const c = baseCase({
      state: "ESCALATED",
      authorization: {
        outcome: "DENY",
        checks: [{ rule: "NO_CONTRADICTIONS", passed: false, detail: "conflict" }],
        action: null,
      },
      reasons: [{ code: "POLICY_DENIED", detail: "NO_CONTRADICTIONS: conflict" }],
      audit: [
        {
          seq: 1,
          caseId: "CASE-TEST",
          at: "2026-01-01T00:00:00.000Z",
          type: "STATE_TRANSITION",
          from: "POLICY_VALIDATION",
          to: "ESCALATED",
          data: {},
        },
      ],
    });
    assert.equal(outcomeKind(c), "ESCALATED");
    assert.equal(presentsAsSuccessfulRefund(c), false);
    assert.equal(presentsFalseSuccess(c), false);
    assert.equal(executionGateLocked(c), true);
    const v = deriveVerdict(c);
    assert.match(v.headline, /ACTION BLOCKED|ESCALATED/);
    assert.equal(v.tone, "blocked");
  });

  it("adversarial-shaped ESCALATED never shows success tone", () => {
    const c = baseCase({
      state: "ESCALATED",
      authorization: {
        outcome: "DENY",
        checks: [
          {
            rule: "NO_CONTRADICTIONS",
            passed: false,
            detail: "customer states 5000.00 USD, which matches no verified charge or order total",
          },
        ],
        action: null,
      },
      proposal: {
        action: "REFUND_DUPLICATE",
        refundTransactionId: "PAY-X",
        keepTransactionId: "PAY-Y",
        evidenceRefs: [],
        riskFlags: [],
        confidence: 0.9,
        rationale: "fixture",
      },
      reasons: [{ code: "POLICY_DENIED", detail: "NO_CONTRADICTIONS" }],
      audit: [
        {
          seq: 1,
          caseId: "CASE-TEST",
          at: "2026-01-01T00:00:00.000Z",
          type: "STATE_TRANSITION",
          from: "POLICY_VALIDATION",
          to: "ESCALATED",
          data: {},
        },
      ],
    });
    assert.equal(presentsFalseSuccess(c), false);
    assert.notEqual(deriveVerdict(c).tone, "success");
    assert.equal(executionGateLocked(c), true);
  });

  it("CLOSED_NO_ACTION is closed tone, not success refund", () => {
    const c = baseCase({
      state: "CLOSED_NO_ACTION",
      authorization: {
        outcome: "NO_ACTION",
        checks: [{ rule: "ORDER_PAID_EXACTLY_ONCE", passed: true, detail: "ok" }],
        action: null,
      },
      evidence: {
        customer: { id: "C", name: "N" },
        order: { id: "1", customerId: "C", totalMinor: 100, currency: "USD", createdAt: "t" },
        transactions: [],
        refunds: [],
        policy: { id: "p", version: "1", sections: [] },
        customerIntent: "DUPLICATE_CHARGE_REFUND",
        intentCues: { duplicateCharge: true, outOfScope: [] },
        duplicateGroups: [],
        financial: { netPaidMinor: 100, orderTotalMinor: 100, status: "PAID_EXACTLY_ONCE" },
        mentionedAmounts: [],
        contradictions: [],
        sourceIds: [],
      },
      audit: [
        {
          seq: 1,
          caseId: "CASE-TEST",
          at: "2026-01-01T00:00:00.000Z",
          type: "STATE_TRANSITION",
          from: "POLICY_VALIDATION",
          to: "CLOSED_NO_ACTION",
          data: {},
        },
      ],
    });
    assert.equal(outcomeKind(c), "CLOSED_NO_ACTION");
    assert.equal(presentsAsSuccessfulRefund(c), false);
    assert.equal(presentsFalseSuccess(c), false);
    assert.equal(deriveVerdict(c).tone, "closed");
    assert.equal(executionGateLocked(c), true);
  });

  it("FAILED never presents verified refund success", () => {
    const c = baseCase({
      state: "FAILED",
      reasons: [{ code: "MODEL_OUTPUT_INVALID", detail: "bad" }],
      audit: [
        {
          seq: 1,
          caseId: "CASE-TEST",
          at: "2026-01-01T00:00:00.000Z",
          type: "STATE_TRANSITION",
          from: "ANALYZING",
          to: "FAILED",
          data: {},
        },
      ],
    });
    assert.equal(outcomeKind(c), "FAILED");
    assert.equal(presentsAsSuccessfulRefund(c), false);
    assert.equal(presentsFalseSuccess(c), false);
    assert.equal(deriveVerdict(c).tone, "failed");
    assert.match(deriveVerdict(c).headline, /FAILED/);
  });
});
