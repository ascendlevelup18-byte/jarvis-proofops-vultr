/**
 * Outcome presentation guards — pure helpers used by UI + tests.
 * Ensures RESOLVED/ESCALATED/CLOSED_NO_ACTION/FAILED never render false success.
 */

import type { Case } from "./case-types.ts";
import { deriveVerdict } from "./verdict.ts";

export type OutcomeKind = "RESOLVED" | "ESCALATED" | "CLOSED_NO_ACTION" | "FAILED" | "IN_PROGRESS";

export function outcomeKind(caseData: Case): OutcomeKind {
  if (
    caseData.state === "RESOLVED" ||
    caseData.state === "ESCALATED" ||
    caseData.state === "CLOSED_NO_ACTION" ||
    caseData.state === "FAILED"
  ) {
    return caseData.state;
  }
  return "IN_PROGRESS";
}

/** True if the UI would claim a successful verified refund. */
export function presentsAsSuccessfulRefund(caseData: Case): boolean {
  const v = deriveVerdict(caseData);
  return v.tone === "success" && caseData.state === "RESOLVED";
}

/** Adversarial / blocked cases must never present success. */
export function presentsFalseSuccess(caseData: Case): boolean {
  if (caseData.state === "RESOLVED") return false;
  const v = deriveVerdict(caseData);
  // Non-RESOLVED cases must never use success tone or refund-success copy
  if (v.tone === "success") return true;
  if (
    (caseData.state === "ESCALATED" ||
      caseData.state === "FAILED" ||
      caseData.state === "CLOSED_NO_ACTION") &&
    /RESOLVED|VERIFIED REFUND/i.test(v.headline)
  ) {
    return true;
  }
  return false;
}

export function executionGateLocked(caseData: Case): boolean {
  if (caseData.action != null) return false;
  return (
    caseData.authorization?.outcome === "DENY" ||
    caseData.authorization?.outcome === "NO_ACTION" ||
    caseData.state === "ESCALATED" ||
    caseData.state === "CLOSED_NO_ACTION"
  );
}
