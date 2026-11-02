// Core contracts. Everything crossing a trust boundary (HTTP input, model output)
// is parsed with these schemas at runtime; everything else is a plain type.
import { z } from "zod";

export const CURRENCIES = ["USD", "EUR", "GBP"] as const;
export type Currency = (typeof CURRENCIES)[number];

// ---------- Ingest ----------

export const CaseRequestSchema = z
  .object({
    customerId: z.string().regex(/^CUST-\d{1,10}$/),
    orderId: z.string().trim().min(1).max(32),
    message: z.string().trim().min(1).max(4000),
  })
  .strict();
export type CaseRequest = z.infer<typeof CaseRequestSchema>;

// ---------- Structured request (output of request understanding; untrusted) ----------

// Only DUPLICATE_CHARGE_REFUND is inside autonomous scope; everything else escalates.
export const CUSTOMER_INTENTS = [
  "DUPLICATE_CHARGE_REFUND",
  "FULL_ORDER_CANCELLATION",
  "GENERAL_REFUND",
  "UNKNOWN",
  "OTHER",
] as const;
export type CustomerIntent = (typeof CUSTOMER_INTENTS)[number];

export const MoneyMentionSchema = z
  .object({
    text: z.string().max(64),
    amountMinor: z.number().int().nonnegative(),
    // ISO-4217-style code as stated (may be unsupported, e.g. "CAD"); null = no currency stated.
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  })
  .strict();
export type MoneyMention = z.infer<typeof MoneyMentionSchema>;

export const StructuredRequestSchema = z
  .object({
    intent: z.enum(CUSTOMER_INTENTS),
    mentionedAmounts: z.array(MoneyMentionSchema).max(10),
  })
  .strict();
export type StructuredRequest = z.infer<typeof StructuredRequestSchema>;

// ---------- Commerce records (system of record; never model output) ----------

export interface Customer {
  id: string;
  name: string;
}

export interface Order {
  id: string;
  customerId: string;
  totalMinor: number;
  currency: Currency;
  createdAt: string;
}

export interface PaymentTransaction {
  id: string;
  orderId: string;
  customerId: string;
  amountMinor: number;
  currency: Currency;
  status: "SUCCEEDED" | "FAILED" | "PENDING";
  refundedMinor: number;
  createdAt: string;
}

export interface Refund {
  id: string;
  transactionId: string;
  amountMinor: number;
  currency: Currency;
  status: "SUCCEEDED" | "FAILED";
  idempotencyKey: string;
  createdAt: string;
}

export interface PolicySection {
  id: string;
  text: string;
}

export interface RefundPolicy {
  id: string;
  version: string;
  sections: PolicySection[];
  duplicateWindowMinutes: number;
  autoRefundLimitMinor: Record<Currency, number>;
  minModelConfidence: number;
}

// ---------- Evidence ----------

export interface DuplicateGroup {
  transactionIds: string[]; // ordered by createdAt
  amountMinor: number;
  currency: Currency;
}

// Derived deterministically from successful charges net of refunds.
export interface FinancialState {
  netPaidMinor: number;
  orderTotalMinor: number;
  status: "PAID_EXACTLY_ONCE" | "OVERPAID" | "UNDERPAID";
}

export interface EvidenceBundle {
  customer: Customer;
  order: Order;
  transactions: PaymentTransaction[];
  refunds: Refund[];
  policy: RefundPolicy;
  customerIntent: CustomerIntent;
  // Deterministic reading of the raw message; must corroborate customerIntent.
  intentCues: { duplicateCharge: boolean; outOfScope: string[] };
  duplicateGroups: DuplicateGroup[];
  financial: FinancialState;
  // Amounts the customer stated: structured understanding output plus a deterministic scan.
  mentionedAmounts: MoneyMention[];
  contradictions: string[];
  // Every id the model may legitimately cite.
  sourceIds: string[];
}

// ---------- Model output ----------

export const DecisionProposalSchema = z
  .object({
    action: z.enum(["REFUND_DUPLICATE", "NO_ACTION", "ESCALATE"]),
    refundTransactionId: z.string().max(64).nullable(),
    keepTransactionId: z.string().max(64).nullable(),
    evidenceRefs: z.array(z.string().max(64)).max(30),
    riskFlags: z.array(z.string().max(200)).max(10),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(2000),
  })
  .strict(); // no amounts, no "verified", no extra keys
export type DecisionProposal = z.infer<typeof DecisionProposalSchema>;

// ---------- Authorization / action / verification ----------

export interface PolicyCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface RefundAction {
  transactionId: string;
  amountMinor: number; // derived from records, never from the model
  currency: Currency;
  idempotencyKey: string;
}

export interface AuthorizationDecision {
  outcome: "APPROVE" | "DENY" | "NO_ACTION";
  checks: PolicyCheck[];
  action: RefundAction | null; // non-null iff outcome === "APPROVE"
}

export interface ActionResult {
  status: "ACCEPTED" | "ERROR";
  providerRefundId: string | null;
  // The gateway returned a refund that already existed for this idempotency key: no new money moved.
  replayed?: boolean;
  error: string | null;
  attemptedAt: string;
}

export interface VerificationResult {
  verified: boolean;
  observedRefund: Refund | null;
  detail: string;
}

// ---------- Case lifecycle ----------

export const CASE_STATES = [
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
  "ESCALATED",
  "FAILED",
  "CLOSED_NO_ACTION",
] as const;
export type CaseState = (typeof CASE_STATES)[number];

export type ReasonCode =
  | "CUSTOMER_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "ORDER_OWNERSHIP_MISMATCH"
  | "POLICY_DENIED"
  | "STALE_EVIDENCE"
  | "UNDERSTANDING_TIMEOUT"
  | "UNDERSTANDING_ERROR"
  | "UNDERSTANDING_OUTPUT_INVALID"
  | "MODEL_TIMEOUT"
  | "MODEL_ERROR"
  | "MODEL_OUTPUT_INVALID"
  | "EXECUTION_NOT_VERIFIED"
  | "REFUND_ALREADY_EXECUTED"
  | "INTERNAL_ERROR";

export interface Reason {
  code: ReasonCode;
  detail: string;
}

export interface AuditEvent {
  seq: number;
  caseId: string;
  at: string;
  type: "STATE_TRANSITION" | "UNDERSTANDING_CALL" | "MODEL_CALL" | "POLICY_EVALUATED" | "ACTION_ATTEMPTED" | "VERIFICATION";
  from: CaseState | null;
  to: CaseState | null;
  data: unknown;
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
  reasons: Reason[]; // why the case ended ESCALATED / FAILED / CLOSED_NO_ACTION
  audit: AuditEvent[];
}
