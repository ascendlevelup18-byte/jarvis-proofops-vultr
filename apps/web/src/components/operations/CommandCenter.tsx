import { FIXTURE_BENCHMARK, pct } from "../../lib/bench-metrics.ts";
import type { SessionCaseEntry } from "../../lib/session-store.ts";
import { countByState } from "../../lib/session-store.ts";
import { DEMO_SCENARIOS, type DemoScenario } from "../../fixtures/demo-scenarios.ts";
import { DemoScenariosBar } from "../layout/DemoScenariosBar.tsx";
import { SafetyShowdown, type ShowdownSide, type ShowdownState } from "../proof/SafetyShowdown.tsx";
import type { Case } from "../../lib/case-types.ts";
import { FixtureBenchmarkNotice } from "../ui/FixtureBenchmarkNotice.tsx";
import { StateBadge } from "../ui/StateBadge.tsx";
import { EmptyState, KpiCard, PageHeader } from "../ui/Primitives.tsx";

export function CommandCenter({
  history,
  loading,
  activeDemoId,
  error,
  onRunDemo,
  onOpenCase,
  showdown,
  onRunShowdown,
  onOpenShowdownSide,
}: {
  history: SessionCaseEntry[];
  loading: boolean;
  activeDemoId?: string;
  error: string | null;
  onRunDemo: (s: DemoScenario) => void;
  onOpenCase: (entry: SessionCaseEntry) => void;
  showdown: ShowdownState;
  onRunShowdown: (risky: DemoScenario) => void;
  onOpenShowdownSide: (side: ShowdownSide & { result: Case }) => void;
}) {
  const counts = countByState(history);

  return (
    <div className="motion-fade-in space-y-5">
      <PageHeader
        title="Proof Mode"
        description="Compare refund decisions and inspect the evidence. AI proposes; policy authorizes; refunds are verified. Payments are simulated."
      />

      <section
        aria-label="Pre-kickoff fixture benchmark metrics"
      >
        <FixtureBenchmarkNotice className="mb-3" />
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            label="Safe resolution rate"
            value={pct(FIXTURE_BENCHMARK.safeResolutionRate)}
            hint={`Fixture bench · ${FIXTURE_BENCHMARK.passed}/${FIXTURE_BENCHMARK.totalCases}`}
          />
          <MetricCard
            label="Correct escalation"
            value={pct(FIXTURE_BENCHMARK.correctEscalationRate)}
            hint={`Fixture bench · ${FIXTURE_BENCHMARK.correctEscalations}/${FIXTURE_BENCHMARK.groundTruthEscalation}`}
          />
          <MetricCard
            label="Unsafe actions"
            value={String(FIXTURE_BENCHMARK.unsafeAutonomousActions)}
            hint="Safety target: 0"
          />
          <MetricCard
            label="Cases in this browser"
            value={String(history.length)}
            hint={`R ${counts.RESOLVED} · E ${counts.ESCALATED} · C ${counts.CLOSED_NO_ACTION}`}
          />
        </dl>
      </section>

      <SafetyShowdown
        state={showdown}
        riskyOptions={DEMO_SCENARIOS.filter((d) => d.id === "prompt-injection" || d.id === "conflicting-amount")}
        onRun={onRunShowdown}
        onOpen={onOpenShowdownSide}
      />

      <DemoScenariosBar loading={loading} activeId={activeDemoId} onRunDemo={onRunDemo} />

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-surface)] px-4 py-3 text-sm text-[var(--color-danger)]"
        >
          {error}
        </div>
      )}

      <section aria-labelledby="case-queue-title">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 id="case-queue-title" className="text-base font-semibold text-[var(--color-jarvis-ink)]">
            Case queue
          </h3>
          <span className="text-xs text-[var(--color-jarvis-faint)]">
            Browser history · {DEMO_SCENARIOS.length} demo scenarios
          </span>
        </div>
        {history.length === 0 ? (
          <EmptyState title="No recorded cases yet" body="Choose a scenario or request a refund in the demo store." />
        ) : (
          <ul className="divide-y divide-[var(--color-jarvis-border)] overflow-hidden rounded-lg shadow-card border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)]">
            {history.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => onOpenCase(entry)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--color-jarvis-surface-2)]"
                >
                  <StateBadge state={entry.state} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--color-jarvis-ink)]">
                      {entry.scenarioTitle ?? `Order #${entry.orderId}`}
                    </p>
                    <p className="font-mono text-[11px] text-[var(--color-jarvis-muted)]">
                      {entry.customerId} · #{entry.orderId} · {entry.id}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-[var(--color-deterministic-accent)]">Open investigation →</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <KpiCard label={label} value={value} hint={hint} />;
}
