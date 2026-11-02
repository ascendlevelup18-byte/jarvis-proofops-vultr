import type { CaseState } from "../../lib/case-types.ts";

const styles: Record<string, string> = {
  RESOLVED: "bg-[var(--color-policy-accent)]/10 text-[var(--color-policy-accent)] ring-[var(--color-policy-accent)]/30",
  ESCALATED: "bg-[var(--color-warning)]/10 text-[var(--color-warning)] ring-[var(--color-warning)]/30",
  FAILED: "bg-[var(--color-danger)]/10 text-[var(--color-danger)] ring-[var(--color-danger)]/30",
  CLOSED_NO_ACTION: "bg-[var(--color-jarvis-border)]/40 text-[var(--color-jarvis-muted)] ring-[var(--color-jarvis-border)]",
  default: "bg-[var(--color-info)]/10 text-[var(--color-info)] ring-[var(--color-info)]/30",
};

export function StateBadge({ state }: { state: CaseState | string }) {
  const cls = styles[state] ?? styles.default;
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${cls}`}>
      {({ RESOLVED: "Refund verified", ESCALATED: "Needs review", FAILED: "Could not complete", CLOSED_NO_ACTION: "Nothing to change", RECEIVED: "Received", EXTRACTING: "Reading request", EVIDENCE_GATHERING: "Checking records", ANALYZING: "Reviewing", DECISION_PROPOSED: "Action suggested", POLICY_VALIDATION: "Checking permissions", APPROVED: "Authorized", EXECUTING: "Running", VERIFYING: "Verifying" } as Record<string, string>)[state] ?? state.replaceAll("_", " ")}
    </span>
  );
}
