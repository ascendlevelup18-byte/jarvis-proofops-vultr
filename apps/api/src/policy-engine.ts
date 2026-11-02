// Deterministic authorization. The model's proposal is treated as a claim to be
// checked against records; the refund amount is derived here, never taken from it.
import type {
  AuthorizationDecision,
  CaseRequest,
  DecisionProposal,
  EvidenceBundle,
  PolicyCheck,
} from "./contracts.ts";
import { formatMinor } from "./money.ts";

export interface Permissions {
  autoRefund: boolean;
}

// Scoped to the order, not the charge: policy allows at most one autonomous duplicate
// refund per order, so a concurrent case that picked a *different* charge is deduplicated
// by the provider and then fails read-back verification instead of refunding twice.
export function refundIdempotencyKey(orderId: string): string {
  return `jarvis-dup-refund:${orderId}`;
}

export function authorize(
  proposal: DecisionProposal,
  ev: EvidenceBundle,
  req: CaseRequest,
  permissions: Permissions,
): AuthorizationDecision {
  const checks: PolicyCheck[] = [];
  const check = (rule: string, passed: boolean, detail: string) => checks.push({ rule, passed, detail });
  const deny = (): AuthorizationDecision => ({ outcome: "DENY", checks, action: null });
  const allPassed = () => checks.every((c) => c.passed);

  // Evidence completeness: checks that apply to every autonomous outcome, including
  // closing with no action. Unknown or missing evidence is never treated as safe.
  check(
    "INTENT_SUPPORTED",
    ev.customerIntent === "DUPLICATE_CHARGE_REFUND",
    `customer intent ${ev.customerIntent}; autonomous scope is DUPLICATE_CHARGE_REFUND only`,
  );
  // The understanding adapter has no unilateral authority over intent: the raw text must
  // deterministically corroborate a duplicate-charge request and ask for nothing else.
  const cues = ev.intentCues;
  check(
    "INTENT_CORROBORATED",
    cues.duplicateCharge && cues.outOfScope.length === 0,
    cues.outOfScope.length
      ? `message also requests: ${cues.outOfScope.join(", ")}`
      : cues.duplicateCharge
        ? "message states a duplicate charge"
        : "message does not state a duplicate charge",
  );
  check("POLICY_AVAILABLE", ev.policy.sections.length > 0, `${ev.policy.id} v${ev.policy.version}`);
  check("ORDER_OWNERSHIP", ev.order.customerId === req.customerId, `order ${ev.order.id} owner ${ev.order.customerId}`);
  const succeeded = ev.transactions.filter((t) => t.status === "SUCCEEDED").length;
  check("PAYMENT_RECORDS_PRESENT", succeeded > 0, `${succeeded} successful payment record(s)`);
  const pending = ev.transactions.filter((t) => t.status === "PENDING").map((t) => t.id);
  check("PAYMENT_STATES_FINAL", pending.length === 0, pending.length ? `pending: ${pending.join(", ")}` : "all final");
  const currencies = new Set<string>([
    ev.order.currency,
    ...ev.transactions.map((t) => t.currency),
    ...ev.mentionedAmounts.flatMap((m) => (m.currency ? [m.currency] : [])),
  ]);
  check("CURRENCY_CONSISTENT", currencies.size === 1, [...currencies].join(", "));
  check(
    "NO_CONTRADICTIONS",
    ev.contradictions.length === 0,
    ev.contradictions.length ? ev.contradictions.join("; ") : "none",
  );
  const unknownRefs = proposal.evidenceRefs.filter((r) => !ev.sourceIds.includes(r));
  check("EVIDENCE_REFS_VALID", unknownRefs.length === 0, unknownRefs.length ? `unknown: ${unknownRefs.join(", ")}` : "ok");

  if (proposal.action === "ESCALATE") {
    check("MODEL_PROPOSAL", false, `model requested escalation: ${proposal.rationale}`);
    return deny();
  }

  if (proposal.action === "NO_ACTION") {
    // Closing is allowed only when records positively show the customer is already
    // correctly charged, never merely because no duplicate was found.
    const f = ev.financial;
    check(
      "ORDER_PAID_EXACTLY_ONCE",
      f.status === "PAID_EXACTLY_ONCE",
      `${f.status}: net paid ${formatMinor(f.netPaidMinor, ev.order.currency)}, order total ${formatMinor(f.orderTotalMinor, ev.order.currency)}`,
    );
    return allPassed() ? { outcome: "NO_ACTION", checks, action: null } : deny();
  }

  // REFUND_DUPLICATE
  check("NO_MODEL_RISK_FLAGS", proposal.riskFlags.length === 0, proposal.riskFlags.join("; ") || "none");
  check(
    "MODEL_CONFIDENCE",
    proposal.confidence >= ev.policy.minModelConfidence,
    `${proposal.confidence} vs minimum ${ev.policy.minModelConfidence}`,
  );
  check("REFUND_PERMITTED", permissions.autoRefund, permissions.autoRefund ? "autonomous refunds enabled" : "disabled");

  const refundId = proposal.refundTransactionId;
  const keepId = proposal.keepTransactionId;
  const refundTx = ev.transactions.find((t) => t.id === refundId);
  const keepTx = ev.transactions.find((t) => t.id === keepId);
  if (!refundTx || !keepTx || refundId === keepId) {
    check("TRANSACTIONS_IN_EVIDENCE", false, `refund=${refundId} keep=${keepId} must be distinct ids from the records`);
    return deny();
  }
  check("TRANSACTIONS_IN_EVIDENCE", true, `refund=${refundTx.id} keep=${keepTx.id}`);

  check(
    "DUPLICATE_VERIFIED",
    ev.duplicateGroups.some((g) => g.transactionIds.includes(refundTx.id) && g.transactionIds.includes(keepTx.id)),
    "both charges in the same duplicate group",
  );
  const priorRefunds = ev.refunds.filter((r) => r.transactionId === refundTx.id && r.status === "SUCCEEDED");
  check(
    "NOT_ALREADY_REFUNDED",
    refundTx.status === "SUCCEEDED" && refundTx.refundedMinor === 0 && priorRefunds.length === 0,
    `${refundTx.id} refunded ${formatMinor(refundTx.refundedMinor, refundTx.currency)}`,
  );
  check(
    "KEPT_CHARGE_INTACT",
    keepTx.status === "SUCCEEDED" && keepTx.refundedMinor === 0,
    `${keepTx.id} refunded ${formatMinor(keepTx.refundedMinor, keepTx.currency)}`,
  );

  // Amount comes from the verified transaction record.
  const amountMinor = refundTx.amountMinor - refundTx.refundedMinor;
  const netPaid = ev.transactions
    .filter((t) => t.status === "SUCCEEDED" && t.currency === ev.order.currency)
    .reduce((sum, t) => sum + t.amountMinor - t.refundedMinor, 0);
  const netAfter = netPaid - amountMinor;
  check(
    "ORDER_PAID_EXACTLY_ONCE",
    refundTx.currency === ev.order.currency && netAfter === ev.order.totalMinor,
    `paid after refund ${formatMinor(netAfter, ev.order.currency)}, order total ${formatMinor(ev.order.totalMinor, ev.order.currency)}`,
  );
  const limit = ev.policy.autoRefundLimitMinor[refundTx.currency];
  check(
    "WITHIN_AUTHORITY",
    amountMinor > 0 && amountMinor <= limit,
    `${formatMinor(amountMinor, refundTx.currency)} vs limit ${formatMinor(limit, refundTx.currency)}`,
  );

  if (!allPassed()) return deny();
  return {
    outcome: "APPROVE",
    checks,
    action: {
      transactionId: refundTx.id,
      amountMinor,
      currency: refundTx.currency,
      idempotencyKey: refundIdempotencyKey(ev.order.id),
    },
  };
}
