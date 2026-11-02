import type { Case, CaseState } from "./case-types.ts";
import { formatMinor } from "./money.ts";

export type VerdictTone = "success" | "blocked" | "closed" | "failed" | "progress";

export interface CaseVerdict {
  headline: string;
  tone: VerdictTone;
  storyLines: string[];
}

/** Every policy rule the backend can emit; unknown rules fall back to the raw rule id. */
export const CHECK_LABELS: Record<string, string> = {
  NO_CONTRADICTIONS: "EVIDENCE CONTRADICTION",
  CURRENCY_CONSISTENT: "CURRENCY CONFLICT",
  INTENT_SUPPORTED: "UNSUPPORTED REQUEST TYPE",
  INTENT_CORROBORATED: "REQUEST NOT CORROBORATED BY MESSAGE",
  PAYMENT_RECORDS_PRESENT: "PAYMENT RECORDS MISSING",
  PAYMENT_STATES_FINAL: "PAYMENT NOT FINAL",
  ORDER_OWNERSHIP: "ORDER OWNERSHIP NOT ESTABLISHED",
  ORDER_PAID_EXACTLY_ONCE: "ORDER NOT PAID EXACTLY ONCE",
  DUPLICATE_VERIFIED: "DUPLICATE NOT VERIFIED",
  NOT_ALREADY_REFUNDED: "CHARGE ALREADY REFUNDED",
  KEPT_CHARGE_INTACT: "KEPT CHARGE NOT INTACT",
  WITHIN_AUTHORITY: "ABOVE AUTONOMOUS AUTHORITY",
  REFUND_PERMITTED: "AUTONOMOUS REFUNDS DISABLED",
  MODEL_CONFIDENCE: "MODEL CONFIDENCE BELOW MINIMUM",
  NO_MODEL_RISK_FLAGS: "MODEL FLAGGED RISK",
  TRANSACTIONS_IN_EVIDENCE: "PROPOSED CHARGES NOT IN RECORDS",
  EVIDENCE_REFS_VALID: "PROPOSAL CITED UNKNOWN EVIDENCE",
  MODEL_PROPOSAL: "MODEL REQUESTED ESCALATION",
  POLICY_AVAILABLE: "POLICY UNAVAILABLE",
};

/** Escalation reasons without a DENY authorization; other codes fall back to the raw code. */
export const REASON_LABELS: Record<string, string> = {
  CUSTOMER_NOT_FOUND: "CUSTOMER NOT FOUND",
  ORDER_NOT_FOUND: "ORDER NOT FOUND",
  ORDER_OWNERSHIP_MISMATCH: "ORDER OWNERSHIP MISMATCH",
  STALE_EVIDENCE: "RECORDS CHANGED BEFORE EXECUTION",
};

/** True iff the engine entered EXECUTING (refund call was about to / did run). */
export function executionStarted(c: Case): boolean {
  return c.audit.some((e) => e.type === "STATE_TRANSITION" && e.to === "EXECUTING");
}

/** State the case left when it terminated (from of the last STATE_TRANSITION). */
export function stoppedFromState(c: Case): CaseState | null {
  const last = [...c.audit].reverse().find((e) => e.type === "STATE_TRANSITION");
  return (last?.from as CaseState | null) ?? null;
}

export function deriveVerdict(caseData: Case): CaseVerdict {
  const { state, authorization, verification, evidence, action } = caseData;
  const storyLines: string[] = [];

  if (state === "RESOLVED") {
    if (authorization?.outcome === "APPROVE" && authorization.action) {
      storyLines.push(
        `REFUND AUTHORIZED → ${formatMinor(authorization.action.amountMinor, authorization.action.currency)} on ${authorization.action.transactionId}`,
      );
    }
    if (action?.status === "ACCEPTED") {
      storyLines.push("Execution accepted by payment provider");
    }
    if (verification?.verified && verification.observedRefund) {
      storyLines.push(
        `Verified after action: ${formatMinor(verification.observedRefund.amountMinor, verification.observedRefund.currency)}`,
      );
    }
    return { headline: "RESOLVED — VERIFIED REFUND", tone: "success", storyLines };
  }

  if (state === "CLOSED_NO_ACTION") {
    storyLines.push("NO ACTION REQUIRED");
    if (evidence?.financial.status === "PAID_EXACTLY_ONCE") {
      storyLines.push(
        `Evidence: PAID EXACTLY ONCE · net ${formatMinor(evidence.financial.netPaidMinor, evidence.order.currency)} equals order total`,
      );
    }
    if (authorization?.outcome === "NO_ACTION") {
      storyLines.push("Policy outcome NO_ACTION — authorization withheld a refund");
    }
    storyLines.push("$0.00 dispatched");
    return { headline: "CLOSED — NO ACTION REQUIRED", tone: "closed", storyLines };
  }

  if (state === "ESCALATED") {
    const failed = authorization?.checks.filter((c) => !c.passed) ?? [];
    if (failed.length > 0) {
      for (const c of failed) {
        storyLines.push(`${CHECK_LABELS[c.rule] ?? c.rule} — ${c.detail}`);
      }
    } else {
      for (const r of caseData.reasons) {
        storyLines.push(`${REASON_LABELS[r.code] ?? r.code} — ${r.detail}`);
      }
    }
    if (authorization?.outcome === "DENY") {
      storyLines.push("AUTHORIZATION DENIED — policy gate withheld execution");
    }
    storyLines.push("$0.00 dispatched · EXECUTION GATE LOCKED");
    return { headline: "ACTION BLOCKED — ESCALATED", tone: "blocked", storyLines };
  }

  if (state === "FAILED") {
    const started = executionStarted(caseData);
    const reason = caseData.reasons[0];

    if (!started) {
      const from = stoppedFromState(caseData);
      storyLines.push(`Stopped during ${from ?? "unknown"}`);
      if (reason) {
        storyLines.push(`${reason.code} — ${reason.detail}`);
      }
      storyLines.push("$0.00 dispatched — refund was never attempted");
      return { headline: "FAILED — NO ACTION TAKEN", tone: "failed", storyLines };
    }

    if (verification?.verified === false) {
      const provider =
        action != null
          ? `Provider response: ${action.status}${action.error ? ` — ${action.error}` : ""}`
          : "Provider response: unknown";
      storyLines.push(provider);
      storyLines.push(`Read-back: ${verification.detail}`);
      storyLines.push("Outcome uncertain — requires human reconciliation with the provider");
      return { headline: "FAILED — REFUND NOT CONFIRMED", tone: "failed", storyLines };
    }

    // executionStarted && verification == null
    if (reason) {
      storyLines.push(`${reason.code} — ${reason.detail}`);
    }
    storyLines.push("A refund call may have been made — verify with the provider");
    return { headline: "FAILED — EXECUTION OUTCOME UNCERTAIN", tone: "failed", storyLines };
  }

  return { headline: formatInProgress(state), tone: "progress", storyLines: [] };
}

function formatInProgress(state: CaseState): string {
  return `${state.replaceAll("_", " ")} — IN PROGRESS`;
}
