import { DemoScenariosBar } from "../components/layout/DemoScenariosBar.tsx";
import { EmptyState, PageHeader, Pill } from "../components/ui/Primitives.tsx";
import { StateBadge } from "../components/ui/StateBadge.tsx";
import type { DemoScenario } from "../fixtures/demo-scenarios.ts";
import { verificationStateOf } from "../lib/commerce.ts";
import { countByState, type SessionCaseEntry } from "../lib/session-store.ts";

export function CasesPage({
  history,
  loading,
  activeDemoId,
  onRunDemo,
  onOpenCase,
}: {
  history: SessionCaseEntry[];
  loading: boolean;
  activeDemoId?: string;
  onRunDemo: (s: DemoScenario) => void;
  onOpenCase: (entry: SessionCaseEntry) => void;
}) {
  const counts = countByState(history);
  return (
    <div className="motion-fade-in space-y-4">
      <PageHeader
        title="Cases"
        description="Cases saved in this browser, newest first. Open a case to review its decision and evidence."
      />
      <DemoScenariosBar loading={loading} activeId={activeDemoId} onRunDemo={onRunDemo} />
      <ul aria-label="Case counts" className="flex flex-wrap gap-2">
        <li><Pill tone="success">Resolved {counts.RESOLVED}</Pill></li>
        <li><Pill tone="warning">Escalated {counts.ESCALATED}</Pill></li>
        <li><Pill tone="neutral">Closed, no action {counts.CLOSED_NO_ACTION}</Pill></li>
        <li><Pill tone="danger">Failed {counts.FAILED}</Pill></li>
      </ul>
      {history.length === 0 ? (
        <EmptyState title="No recorded cases yet" body="Run a scenario above, or request a refund from the demo store." />
      ) : (
        <ul className="divide-y divide-[var(--color-jarvis-border)] overflow-hidden rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-card">
          {history.map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={() => onOpenCase(entry)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-jarvis-surface-2)]">
                <StateBadge state={entry.state} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{entry.scenarioTitle ?? `Order #${entry.orderId}`}</p>
                  <p className="truncate font-mono text-[11px] text-[var(--color-jarvis-muted)]">
                    {entry.customerId} · #{entry.orderId} · {entry.id}
                  </p>
                </div>
                <span className="text-xs text-[var(--color-jarvis-muted)]">Verification: {verificationStateOf(entry.caseData)}</span>
                <span className="text-xs tabular-nums text-[var(--color-jarvis-faint)]">
                  {new Date(entry.submittedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
