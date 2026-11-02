// Case state machine. The table defines legal edges; guards enforce the
// invariants that the table alone cannot express.
import type { Case, CaseState } from "./contracts.ts";

export const TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  RECEIVED: ["EXTRACTING", "FAILED"],
  EXTRACTING: ["EVIDENCE_GATHERING", "FAILED"],
  EVIDENCE_GATHERING: ["ANALYZING", "ESCALATED", "FAILED"],
  ANALYZING: ["DECISION_PROPOSED", "FAILED"],
  DECISION_PROPOSED: ["POLICY_VALIDATION", "FAILED"],
  POLICY_VALIDATION: ["APPROVED", "ESCALATED", "CLOSED_NO_ACTION", "FAILED"],
  APPROVED: ["EXECUTING", "ESCALATED", "FAILED"],
  EXECUTING: ["VERIFYING", "FAILED"],
  // CLOSED_NO_ACTION from VERIFYING: the refund call replayed a refund another case had already executed.
  VERIFYING: ["RESOLVED", "CLOSED_NO_ACTION", "FAILED"],
  RESOLVED: [],
  ESCALATED: [],
  FAILED: [],
  CLOSED_NO_ACTION: [],
};

export function isTerminal(s: CaseState): boolean {
  return TRANSITIONS[s].length === 0;
}

export function assertTransition(c: Case, to: CaseState): void {
  if (!TRANSITIONS[c.state].includes(to)) throw new Error(`illegal transition ${c.state} -> ${to}`);
  const approved = c.authorization?.outcome === "APPROVE" && c.authorization.action !== null;
  if ((to === "APPROVED" || to === "EXECUTING") && !approved) {
    throw new Error(`invariant: ${to} requires an APPROVE authorization`);
  }
  if (to === "CLOSED_NO_ACTION") {
    // Policy found nothing owed, or this case's refund call replayed a refund that already existed
    // and read-back confirmed it: either way this case moved no money of its own.
    const replayedAndVerified = c.state === "VERIFYING" && c.action?.replayed === true && c.verification?.verified === true;
    if (c.authorization?.outcome !== "NO_ACTION" && !replayedAndVerified) {
      throw new Error("invariant: CLOSED_NO_ACTION requires a NO_ACTION authorization or a verified replayed refund");
    }
  }
  if (to === "RESOLVED" && c.action?.replayed === true) {
    throw new Error("invariant: a replayed refund cannot resolve a second case");
  }
  if (to === "RESOLVED" && c.verification?.verified !== true) {
    throw new Error("invariant: RESOLVED requires successful verification");
  }
}
