import type { Case } from "../../lib/case-types.ts";
import { deriveVerdict, type VerdictTone } from "../../lib/verdict.ts";

const toneClass: Record<VerdictTone, string> = {
  success: "border-[var(--color-policy-border)] bg-[var(--color-policy-surface)]",
  blocked: "border-[var(--color-warning)]/40 bg-[var(--color-warning-surface)]",
  closed: "border-[var(--color-jarvis-border-strong)] bg-[var(--color-jarvis-surface-2)]",
  failed: "border-[var(--color-danger)]/40 bg-[var(--color-danger-surface)]",
  progress: "border-[var(--color-info)]/40 bg-[var(--color-deterministic)]",
};

const toneText: Record<VerdictTone, string> = {
  success: "text-[var(--color-policy-accent)]",
  blocked: "text-[var(--color-warning)]",
  closed: "text-[var(--color-jarvis-ink)]",
  failed: "text-[var(--color-danger)]",
  progress: "text-[var(--color-info)]",
};

export function VerdictBanner({ caseData }: { caseData: Case }) {
  const verdict = deriveVerdict(caseData);
  return (
    <div className={`motion-slide-up rounded-md border-2 px-5 py-4 ${toneClass[verdict.tone]}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-jarvis-muted)]">
        Investigation verdict
      </p>
      <h2 className={`mt-1 text-2xl font-bold tracking-tight sm:text-3xl ${toneText[verdict.tone]}`}>
        {verdict.headline}
      </h2>
      {verdict.storyLines.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-[var(--color-jarvis-ink)]/90">
          {verdict.storyLines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {(caseData.state === "ESCALATED" ||
        caseData.state === "FAILED" ||
        caseData.state === "CLOSED_NO_ACTION" ||
        caseData.authorization?.outcome === "DENY") &&
        caseData.reasons.length > 0 && (
          <div className="mt-4 border-t border-current/10 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-muted)]">
              Structured reasons
            </p>
            <ul className="mt-1 space-y-1.5">
              {caseData.reasons.map((r, i) => (
                <li key={i} className="text-sm">
                  <span className="font-mono text-xs font-semibold">{r.code}</span>
                  <span className="mx-1.5 text-[var(--color-jarvis-faint)]">·</span>
                  <span className="text-[var(--color-jarvis-ink)]/85">{r.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      {caseData.state === "CLOSED_NO_ACTION" && caseData.reasons.length === 0 && (
        <p className="mt-4 border-t border-current/10 pt-3 text-sm text-[var(--color-jarvis-muted)]">
          Policy authorized no refund. Ledger already reflects a single correct payment.
        </p>
      )}
    </div>
  );
}
