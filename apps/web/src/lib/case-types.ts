// Display types aligned with apps/api/src/contracts.ts (read-only mirror).

export type CaseState =
  | "RECEIVED"
  | "EXTRACTING"
  | "EVIDENCE_GATHERING"
  | "ANALYZING"
  | "DECISION_PROPOSED"
  | "POLICY_VALIDATION"
  | "APPROVED"
  | "EXECUTING"
  | "VERIFYING"
  | "RESOLVED"
  | "ESCALATED"
  | "FAILED"
  | "CLOSED_NO_ACTION";

export interface CaseRequest {
  customerId: string;
  orderId: string;
  message: string;
}

export interface MoneyMention {
  text: string;
  amountMinor: number;
  currency: string | null;
}

export interface StructuredRequest {
  intent: string;
  mentionedAmounts: MoneyMention[];
}

export interface PolicyCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface RefundAction {
  transactionId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

export interface AuthorizationDecision {
  outcome: "APPROVE" | "DENY" | "NO_ACTION";
  checks: PolicyCheck[];
  action: RefundAction | null;
}

export interface DecisionProposal {
  action: "REFUND_DUPLICATE" | "NO_ACTION" | "ESCALATE";
  refundTransactionId: string | null;
  keepTransactionId: string | null;
  evidenceRefs: string[];
  riskFlags: string[];
  confidence: number;
  rationale: string;
}

export interface ActionResult {
  status: "ACCEPTED" | "ERROR";
  providerRefundId: string | null;
  /** The gateway returned a refund that already existed for this idempotency key: no new money moved. */
  replayed?: boolean;
  error: string | null;
  attemptedAt: string;
}

export interface VerificationResult {
  verified: boolean;
  observedRefund: {
    id: string;
    transactionId: string;
    amountMinor: number;
    currency: string;
    status: string;
  } | null;
  detail: string;
}

export interface Reason {
  code: string;
  detail: string;
}

export interface AuditEvent {
  seq: number;
  caseId: string;
  at: string;
  type: string;
  from: CaseState | null;
  to: CaseState | null;
  data: unknown;
}

export interface EvidenceBundle {
  customer: { id: string; name: string };
  order: {
    id: string;
    customerId: string;
    totalMinor: number;
    currency: string;
    createdAt: string;
  };
  transactions: Array<{
    id: string;
    orderId: string;
    amountMinor: number;
    currency: string;
    status: string;
    refundedMinor: number;
    createdAt: string;
  }>;
  refunds: Array<{
    id: string;
    transactionId: string;
    amountMinor: number;
    currency: string;
    status: string;
  }>;
  policy: { id: string; version: string; sections: Array<{ id: string; text: string }> };
  customerIntent: string;
  intentCues: { duplicateCharge: boolean; outOfScope: string[] };
  duplicateGroups: Array<{ transactionIds: string[]; amountMinor: number; currency: string }>;
  financial: {
    netPaidMinor: number;
    orderTotalMinor: number;
    status: "PAID_EXACTLY_ONCE" | "OVERPAID" | "UNDERPAID";
  };
  mentionedAmounts: MoneyMention[];
  contradictions: string[];
  sourceIds: string[];
}

export interface Case {
  id: string;
  request: CaseRequest;
  state: CaseState;
  createdAt: string;
  updatedAt: string;
  understanding: StructuredRequest | null;
  evidence: EvidenceBundle | null;
  proposal: DecisionProposal | null;
  authorization: AuthorizationDecision | null;
  action: ActionResult | null;
  verification: VerificationResult | null;
  reasons: Reason[];
  audit: AuditEvent[];
}

export const FLOW_STATES: CaseState[] = [
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

export const TERMINAL_STATES: CaseState[] = ["RESOLVED", "ESCALATED", "FAILED", "CLOSED_NO_ACTION"];
