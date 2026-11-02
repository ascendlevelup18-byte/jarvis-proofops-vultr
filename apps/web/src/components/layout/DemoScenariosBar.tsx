import { DEMO_SCENARIOS, type DemoScenario } from "../../fixtures/demo-scenarios.ts";

export function DemoScenariosBar({
  loading,
  activeId,
  onRunDemo,
  compact = false,
}: {
  loading: boolean;
  activeId?: string;
  onRunDemo: (scenario: DemoScenario) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] ${
        compact ? "px-3 py-2" : "px-4 py-3"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-jarvis-faint)]">
          Demo scenarios
        </span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Demo scenarios">
          {DEMO_SCENARIOS.map((s) => {
            const active = activeId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                disabled={loading}
                title={`${s.description} → expected ${s.expectedLabel}`}
                onClick={() => onRunDemo(s)}
                className={`rounded border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                  active
                    ? "border-[var(--color-policy-accent)] bg-[var(--color-policy-accent)]/15 text-[var(--color-jarvis-ink)]"
                    : "border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-bg-elevated)] text-[var(--color-jarvis-muted)] hover:border-[var(--color-jarvis-border-strong)] hover:text-[var(--color-jarvis-ink)]"
                }`}
              >
                {shortLabel(s.id)}
                <span className="sr-only">Expected: {s.expectedLabel}</span>
              </button>
            );
          })}
        </div>
        {loading && (
          <span className="text-xs text-[var(--color-jarvis-muted)]" role="status">
            Processing…
          </span>
        )}
      </div>
    </div>
  );
}

function shortLabel(id: string): string {
  switch (id) {
    case "valid-duplicate":
      return "Valid duplicate";
    case "conflicting-amount":
      return "Conflicting amount";
    case "already-refunded":
      return "Already refunded";
    case "prompt-injection":
      return "Prompt injection";
    default:
      return id;
  }
}
