import type { Case } from "../../lib/case-types.ts";
import { Panel, TrustBadge } from "../ui/Panel.tsx";

/** Human-review panel from structured authorization fails + reasons only — no freeform CoT. */
export function EscalationPanel({ caseData }: { caseData: Case }) {
  if (caseData.state !== "ESCALATED" && caseData.state !== "FAILED") {
    return null;
  }

  const failedChecks = caseData.authorization?.checks.filter((c) => !c.passed) ?? [];
  const contradictions = caseData.evidence?.contradictions ?? [];

  return (
    <Panel id="human-review" title="Human review" variant="danger" badge={<TrustBadge kind="authoritative" />}>
      <p className="mb-3 text-sm font-semibold text-[var(--color-warning)]">
        {caseData.state === "ESCALATED" ? "ESCALATED TO HUMAN" : "FAILED — REQUIRES HUMAN FOLLOW-UP"}
      </p>
      <p className="mb-3 text-[11px] text-[var(--color-jarvis-muted)]">
        Structured fields only — no chain-of-thought · $0.00 dispatched
      </p>

      {failedChecks.length > 0 && (
        <section className="mb-3">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-faint)]">
            Failed authorization checks
          </h4>
          <ul className="mt-1 space-y-1.5">
            {failedChecks.map((c) => (
              <li key={c.rule} className="rounded border border-[var(--color-danger)]/30 bg-[var(--color-jarvis-bg)]/40 px-2 py-1.5 text-xs">
                <span className="font-mono font-semibold">{c.rule}</span>
                <span className="mx-1 text-[var(--color-jarvis-faint)]">—</span>
                {c.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      {contradictions.length > 0 && (
        <section className="mb-3">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-faint)]">
            Evidence conflicts
          </h4>
          <ul className="mt-1 list-inside list-disc text-xs">
            {contradictions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}

      {caseData.reasons.length > 0 && (
        <section className="mb-3">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-faint)]">
            Engine reasons
          </h4>
          <ul className="mt-1 space-y-1 text-xs">
            {caseData.reasons.map((r, i) => (
              <li key={i}>
                <span className="font-mono font-semibold">{r.code}</span>
                <span className="mx-1 text-[var(--color-jarvis-faint)]">·</span>
                {r.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-bg)]/40 px-3 py-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-faint)]">
          Required human choice
        </h4>
        <p className="mt-1 text-xs text-[var(--color-jarvis-muted)]">
          Review evidence conflicts and policy failures, then decide manually. JARVIS will not execute while the
          authorization gate is locked.
        </p>
      </section>
    </Panel>
  );
}
