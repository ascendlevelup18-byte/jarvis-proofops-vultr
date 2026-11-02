import { FIXTURE_BENCHMARK_LABEL, FIXTURE_BENCHMARK_NOTE, FIXTURE_BENCHMARK_SCOPE } from "../../lib/bench-metrics.ts";

/** Mandatory label next to any rendered benchmark figure (enforced by benchmark-labels.test.ts). */
export function FixtureBenchmarkNotice({ id, className = "" }: { id?: string; className?: string }) {
  return (
    <div
      id={id}
      role="note"
      className={`rounded-md border border-[var(--color-warning)]/50 bg-[var(--color-jarvis-surface-2)] px-3 py-2 ${className}`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-warning)]">
        {FIXTURE_BENCHMARK_LABEL}
        <span aria-hidden="true"> · </span>
        <span className="whitespace-nowrap">{FIXTURE_BENCHMARK_SCOPE}</span>
      </p>
      <p className="mt-1 text-xs text-[var(--color-jarvis-muted)]">{FIXTURE_BENCHMARK_NOTE}</p>
    </div>
  );
}
