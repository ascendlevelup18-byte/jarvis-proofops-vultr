import type { Case } from "../../lib/case-types.ts";
import { moneyLanes } from "../../lib/money-lanes.ts";

export function MoneyMovementStrip({ caseData }: { caseData: Case }) {
  const lanes = moneyLanes(caseData);
  return (
    <div className="rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-jarvis-faint)]">
          Did money move?
        </h3>
        <span className="text-[10px] text-[var(--color-jarvis-muted)]">Amounts from records only — not AI text</span>
      </div>
      <div className="grid gap-3 grid-cols-2">
        {lanes.map((lane) => (
          <div key={lane.label} className={lane.muted ? "opacity-50" : ""}>
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-jarvis-muted)]">{lane.label}</p>
            <p
              className={`mt-0.5 font-mono text-sm ${
                lane.emphasize ? "font-semibold text-[var(--color-jarvis-ink)]" : "text-[var(--color-jarvis-ink)]/90"
              }`}
            >
              {lane.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
