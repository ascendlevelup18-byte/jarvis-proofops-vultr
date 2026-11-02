import { useMemo, useState } from "react";
import { BarList } from "../components/charts/BarList.tsx";
import { ChartCard, DataTable } from "../components/charts/ChartCard.tsx";
import { DonutChart } from "../components/charts/DonutChart.tsx";
import { StackedBarChart, type StackColumn } from "../components/charts/StackedBarChart.tsx";
import { FixtureBenchmarkNotice } from "../components/ui/FixtureBenchmarkNotice.tsx";
import { EmptyState, KpiCard, PageHeader, Pill, Segmented } from "../components/ui/Primitives.tsx";
import { StateBadge } from "../components/ui/StateBadge.tsx";
import { btn } from "../components/ui/styles.ts";
import {
  aiStats,
  compare,
  describeDrill,
  drill,
  granularityFor,
  inWindow,
  OUTCOME_LABELS,
  OUTCOME_ORDER,
  RANGE_OPTIONS,
  rangeWindow,
  recordFromEntry,
  REFUND_LABELS,
  REFUND_ORDER,
  summarize,
  timeSeries,
  type AnalyticsRecord,
  type Delta,
  type DrillFilter,
  type Outcome,
  type RangeId,
  type RefundOutcome,
} from "../lib/analytics.ts";
import { FIXTURE_BENCHMARK, pct } from "../lib/bench-metrics.ts";
import { buildOrderRows, type OrderStatusFilter } from "../lib/commerce.ts";
import type { DemoStoreSnapshot } from "../lib/demo-store.ts";
import { formatMinor } from "../lib/money.ts";
import { SAMPLE_DAYS, SAMPLE_PERIOD_END, sampleRecords } from "../lib/sample-analytics.ts";
import type { SessionCaseEntry } from "../lib/session-store.ts";

const OUTCOME_COLOR: Record<Outcome, string> = {
  resolved: "var(--color-chart-resolved)",
  escalated: "var(--color-chart-escalated)",
  closed: "var(--color-chart-closed)",
  failed: "var(--color-chart-failed)",
  open: "var(--color-chart-neutral)",
};
const REFUND_COLOR: Record<RefundOutcome, string> = {
  verified: "var(--color-chart-resolved)",
  blocked: "var(--color-chart-escalated)",
  "not-confirmed": "var(--color-chart-failed)",
  "not-needed": "var(--color-chart-closed)",
  none: "var(--color-chart-neutral)",
};

type DataMode = "recorded" | "sample";
type SourceFilter = "all" | "storefront" | "operations";

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const money = (m: Record<string, number>) => {
  const entries = Object.entries(m);
  return entries.length ? entries.map(([cur, v]) => formatMinor(v, cur)).join(" · ") : formatMinor(0, "USD");
};

export function BenchmarksPage({
  history = [],
  snapshot = null,
  onOpenCase,
  onOpenStore,
  onOpenOrders,
}: {
  history?: SessionCaseEntry[];
  snapshot?: DemoStoreSnapshot | null;
  onOpenCase?: (e: SessionCaseEntry) => void;
  onOpenStore?: () => void;
  onOpenOrders?: (status: OrderStatusFilter) => void;
}) {
  const [mode, setMode] = useState<DataMode>("recorded");
  const [range, setRange] = useState<RangeId>("today");
  const [source, setSource] = useState<SourceFilter>("all");
  const [drillBy, setDrillBy] = useState<DrillFilter>({});
  const [limit, setLimit] = useState(25);
  // The range is anchored when the page opens or a filter changes, never on every render.
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  const sample = mode === "sample";
  const now = sample ? SAMPLE_PERIOD_END : openedAt;
  const all = useMemo<AnalyticsRecord[]>(
    () => (sample ? sampleRecords() : history.map(recordFromEntry).filter((r) => source === "all" || r.source === source)),
    [sample, history, source],
  );
  const w = useMemo(() => rangeWindow(range, now, all), [range, now, all]);
  const records = useMemo(() => all.filter((r) => inWindow(r, w)), [all, w]);
  const s = useMemo(() => summarize(records), [records]);
  const g = granularityFor(range, w);
  const buckets = useMemo(() => timeSeries(records, w, g), [records, w, g]);
  const ai = useMemo(() => aiStats(records), [records]);
  const report = useMemo(() => drill(records, drillBy), [records, drillBy]);
  const delta = (m: (x: ReturnType<typeof summarize>) => number) => compare(all, w, m);

  const rangeLabel = RANGE_OPTIONS.find((o) => o.id === range)!.label;
  const caption = `${sample ? "Sample data" : "Recorded cases"} · ${rangeLabel.toLowerCase()} · ${
    range === "all" && !records.length ? "no records" : `${new Date(w.start).toLocaleDateString()} – ${new Date(w.end).toLocaleDateString()}`
  }`;
  const changeFilters = (fn: () => void) => {
    fn();
    setDrillBy({});
    setLimit(25);
    setOpenedAt(Date.now());
  };
  const focusReport = (f: DrillFilter) => {
    setDrillBy(f);
    setLimit(25);
    requestAnimationFrame(() => document.getElementById("analytics-report")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const columns: StackColumn<Outcome>[] = buckets.map((b) => ({
    id: String(b.start),
    label: b.label,
    title: g === "day" || g === "week" ? new Date(b.start).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + (g === "week" ? " (week)" : "") : `${new Date(b.start).toLocaleDateString()} ${b.label}`,
    values: b.counts,
  }));
  const orderRows = !sample && snapshot ? buildOrderRows(snapshot, history) : null;
  const firstRecorded = history.length ? history.reduce((m, h) => (h.submittedAt < m ? h.submittedAt : m), history[0].submittedAt) : null;

  return (
    <div className="motion-fade-in space-y-5">
      <PageHeader
        title="Analytics"
        description="Refund activity from recorded cases. Store data is synthetic; payments are simulated."
      />

      {/* One filter row scopes everything below it. */}
      <div role="group" aria-label="Analytics filters" className="flex flex-wrap items-center gap-2">
        <label htmlFor="analytics-range" className="sr-only">
          Date range
        </label>
        <select
          id="analytics-range"
          value={range}
          onChange={(e) => changeFilters(() => setRange(e.target.value as RangeId))}
          className="rounded-md border border-[var(--color-jarvis-border-strong)] bg-[var(--color-jarvis-surface)] px-2.5 py-1.5 text-sm font-medium text-[var(--color-jarvis-ink)] shadow-card"
        >
          {RANGE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {!sample && (
          <Segmented
            label="Source"
            value={source}
            onChange={(v) => changeFilters(() => setSource(v))}
            options={[
              { value: "all", label: "All sources" },
              { value: "storefront", label: "Demo store" },
              { value: "operations", label: "Console" },
            ]}
          />
        )}
        <div className="ml-auto">
          <Segmented
            label="Dataset"
            value={mode}
            onChange={(v) => changeFilters(() => {
              setMode(v);
              setRange(v === "sample" ? "30d" : "today");
              setSource("all");
            })}
            options={[
              { value: "recorded", label: "Recorded" },
              { value: "sample", label: "Sample data" },
            ]}
          />
        </div>
      </div>

      {sample ? (
        <div role="note" className="rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning-surface)] px-4 py-2.5 text-sm text-[var(--color-warning)]">
          <strong>Sample data.</strong> A fixed, illustrative set of {sampleRecords().length} cases over the {SAMPLE_DAYS} days ending{" "}
          {new Date(SAMPLE_PERIOD_END).toLocaleDateString()}. Not recorded by this backend, not a merchant's data, no measured latency. Switch to
          Recorded for real cases.
        </div>
      ) : (
        <p className="text-xs text-[var(--color-jarvis-faint)]">
          {firstRecorded
            ? `Recorded in this browser since ${fmtTime(firstRecorded)} · ${history.length} case${history.length === 1 ? "" : "s"} from real /cases responses`
            : "No recorded cases yet."}
        </p>
      )}

      <section aria-label="Executive summary">
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard
            label="Orders in demo store"
            value={sample ? "—" : snapshot ? String(snapshot.orders.length) : "…"}
            hint={sample ? "Not part of the sample set" : "Seeded, synthetic orders"}
          />
          <KpiCard label={sample ? "Sample cases" : "Recorded cases"} value={String(s.cases)} hint={deltaText(delta((x) => x.cases))} />
          <KpiCard label="Resolved (verified)" value={String(s.outcomes.resolved)} hint={deltaText(delta((x) => x.outcomes.resolved))} />
          <KpiCard label="Escalated to a person" value={String(s.outcomes.escalated)} hint={deltaText(delta((x) => x.outcomes.escalated))} />
          <KpiCard
            label={sample ? "Sample refund total" : "Verified simulated refunds"}
            value={money(s.verifiedRefundMinor)}
            hint={sample ? "Illustrative only: not money, not a merchant's history" : `${s.refunds.verified} refund${s.refunds.verified === 1 ? "" : "s"} confirmed by read-back`}
          />
          <KpiCard label={sample ? "Sample resolution rate" : "Autonomous resolution rate"} value={s.autonomousRate === null ? "—" : pct(s.autonomousRate)} hint="Resolved or correctly closed, no person needed" />
          <KpiCard label="Pending reviews" value={String(s.pendingReview)} hint="Escalated or failed; approval is review-only" />
          <KpiCard label="AI calls" value={String(s.aiCalls)} hint={s.aiErrors ? `${s.aiErrors} failed` : "Understanding + decision calls"} />
        </dl>
      </section>

      {s.cases === 0 && !sample && (
        <EmptyState
          title={history.length ? "No recorded cases in this range" : "No recorded cases yet"}
          body={
            history.length
              ? "Choose a wider date range or another source."
              : "Charts fill in from real cases. Request a refund in the demo store, run a scenario in Proof Mode, or switch to Sample data to preview the workspace."
          }
          action={
            !history.length && onOpenStore ? (
              <button type="button" className={btn.primary} onClick={onOpenStore}>
                Open demo store
              </button>
            ) : undefined
          }
        />
      )}

      <section aria-label="Operational trends" className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Cases over time"
          caption={`${caption} · by ${g === "5min" ? "5 minutes" : g}`}
          legend={OUTCOME_ORDER.map((o) => ({ key: o, label: OUTCOME_LABELS[o], color: OUTCOME_COLOR[o] }))}
          table={
            <DataTable
              caption="Cases over time by outcome"
              columns={["Period", ...OUTCOME_ORDER.map((o) => OUTCOME_LABELS[o]), "Total"]}
              rows={buckets.flatMap((b, i) => (b.total ? [[columns[i].title, ...OUTCOME_ORDER.map((o) => b.counts[o]), b.total]] : []))}
            />
          }
        >
          <StackedBarChart
            series={OUTCOME_ORDER.map((o) => ({ key: o, label: OUTCOME_LABELS[o], color: OUTCOME_COLOR[o] }))}
            columns={columns}
            onSelect={(o) => focusReport({ outcome: o })}
            emptyText="No cases in this period."
          />
        </ChartCard>
        <ChartCard
          title="Resolution vs escalation"
          caption={caption}
          table={<DataTable caption="Case outcomes" columns={["Outcome", "Cases"]} rows={OUTCOME_ORDER.map((o) => [OUTCOME_LABELS[o], s.outcomes[o]])} />}
        >
          <DonutChart
            segments={OUTCOME_ORDER.map((o) => ({ key: o, label: OUTCOME_LABELS[o], value: s.outcomes[o], color: OUTCOME_COLOR[o] }))}
            centerLabel="cases"
            onSelect={(o) => focusReport({ outcome: o })}
            emptyText="No outcomes yet."
          />
        </ChartCard>
        <ChartCard
          title="Refund outcomes"
          caption={caption}
          table={<DataTable caption="Refund outcomes" columns={["Outcome", "Cases"]} rows={REFUND_ORDER.map((o) => [REFUND_LABELS[o], s.refunds[o]])} />}
        >
          <DonutChart
            segments={REFUND_ORDER.map((o) => ({ key: o, label: REFUND_LABELS[o], value: s.refunds[o], color: REFUND_COLOR[o] }))}
            centerLabel="cases"
            onSelect={(o) => focusReport({ refund: o })}
            emptyText="No refund decisions yet."
          />
        </ChartCard>
        <ChartCard title="Automation activity" caption={`${caption} · from each case's audit trail`}>
          {ai.length === 0 ? (
            <BarList rows={[]} emptyText="No AI calls recorded in this period." />
          ) : (
            <>
              <BarList
                rows={ai.map((a) => ({
                  key: `${a.stage}-${a.adapter}`,
                  label: `${a.stage} · ${a.adapter}`,
                  value: a.calls,
                  note: a.avgMs === null ? "latency not measured" : `avg ${a.avgMs} ms · p95 ${a.p95Ms} ms`,
                }))}
                emptyText=""
              />
              <p className="mt-3 text-[11px] text-[var(--color-jarvis-faint)]">
                {sample
                  ? "Sample records carry call counts only; latency is never simulated."
                  : ai.some((a) => a.adapter.startsWith("fixture"))
                    ? "Fixture adapters run in-process: their latency is not model inference time."
                    : "Latency as recorded by the engine around each provider call."}
              </p>
            </>
          )}
        </ChartCard>
        <ChartCard title="Support activity" caption={caption}>
          <BarList
            rows={
              sample
                ? [{ key: "sample", label: "Sample requests", value: s.cases }]
                : [
                    { key: "storefront", label: "Customer requests from the demo store", value: s.storefront, onSelect: () => focusReport({ source: "storefront" }) },
                    { key: "operations", label: "Cases run from the console", value: s.cases - s.storefront, onSelect: () => focusReport({ source: "operations" }) },
                    { key: "review", label: "Cases requiring human review", value: s.pendingReview, onSelect: () => focusReport({ reviewOnly: true }) },
                  ]
            }
            emptyText="No support requests in this period."
          />
          <p className="mt-3 text-[11px] text-[var(--color-jarvis-faint)]">Workflow: duplicate-charge refund (the only operational automation).</p>
        </ChartCard>
      </section>

      {!sample && (
        <section aria-label="Business operations" className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Orders by status" caption="Demo store orders joined with the latest recorded case · not range-filtered">
            {orderRows ? (
              <BarList
                rows={(
                  [
                    ["needs-review", "Needs review", orderRows.filter((r) => r.resolution === "ESCALATED" || r.resolution === "FAILED").length],
                    ["refunded", "Refunded", orderRows.filter((r) => r.refundState === "Refunded by JARVIS (simulated)" || r.refundState === "Refunded before JARVIS").length],
                    ["closed", "Closed, no action", orderRows.filter((r) => r.resolution === "CLOSED_NO_ACTION").length],
                    ["no-case", "No case yet", orderRows.filter((r) => !r.latestCase).length],
                  ] as [OrderStatusFilter, string, number][]
                ).map(([key, label, value]) => ({ key, label, value, onSelect: onOpenOrders ? () => onOpenOrders(key) : undefined }))}
                emptyText="No orders."
              />
            ) : (
              <BarList rows={[]} emptyText="Loading the demo store…" />
            )}
          </ChartCard>
          <ChartCard title="Recent operational events" caption={caption}>
            {records.length === 0 ? (
              <BarList rows={[]} emptyText="No events in this period." />
            ) : (
              <ol className="space-y-1.5">
                {[...records]
                  .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
                  .slice(0, 5)
                  .map((r) => (
                    <li key={r.id} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 tabular-nums text-[var(--color-jarvis-faint)]">{fmtTime(r.at)}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--color-jarvis-ink)]">
                        #{r.orderId} · {REFUND_LABELS[r.refund]}
                      </span>
                      {r.entry && onOpenCase ? (
                        <button type="button" className={btn.ghost} onClick={() => onOpenCase(r.entry!)}>
                          Evidence
                        </button>
                      ) : null}
                    </li>
                  ))}
              </ol>
            )}
          </ChartCard>
        </section>
      )}

      <section id="analytics-report" aria-label="Case report" className="scroll-mt-20 rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-jarvis-border)] px-4 py-2.5">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-jarvis-ink)]">Case report</h3>
            <p className="text-[11px] text-[var(--color-jarvis-faint)]">
              {report.length} of {records.length} cases · {describeDrill(drillBy) ?? "all outcomes"} · click a chart segment to filter
            </p>
          </div>
          {describeDrill(drillBy) && (
            <button type="button" className={btn.ghost} onClick={() => setDrillBy({})}>
              Clear filter: {describeDrill(drillBy)}
            </button>
          )}
        </header>
        {report.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--color-jarvis-muted)]">No cases match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">Cases in the selected period and filter</caption>
              <thead className="bg-[var(--color-jarvis-surface-2)] text-xs text-[var(--color-jarvis-muted)]">
                <tr>
                  {["Completed", "Case", "Order", "Source", "Outcome", "Refund", "Amount", ""].map((h) => (
                    <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-jarvis-border)]">
                {report.slice(0, limit).map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-[var(--color-jarvis-muted)]">{fmtTime(r.at)}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px]">{r.id.slice(0, 13)}</td>
                    <td className="whitespace-nowrap px-3 py-2">#{r.orderId}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-[var(--color-jarvis-muted)]">
                      {r.source === "sample" ? "Sample" : r.source === "storefront" ? "Demo store" : "Console"}
                    </td>
                    <td className="px-3 py-2">
                      <StateBadge state={{ resolved: "RESOLVED", escalated: "ESCALATED", closed: "CLOSED_NO_ACTION", failed: "FAILED", open: "IN_PROGRESS" }[r.outcome]} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{REFUND_LABELS[r.refund]}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.refund === "verified" ? formatMinor(r.refundMinor, r.currency) : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {r.entry && onOpenCase ? (
                        <button type="button" className={btn.ghost} onClick={() => onOpenCase(r.entry!)}>
                          Open evidence
                        </button>
                      ) : (
                        <span className="text-[11px] text-[var(--color-jarvis-faint)]">Sample record</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.length > limit && (
              <div className="border-t border-[var(--color-jarvis-border)] px-4 py-2 text-center">
                <button type="button" className={btn.ghost} onClick={() => setLimit((l) => l + 25)}>
                  Show more ({report.length - limit} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <SafetyBenchmark />
    </div>
  );
}

function deltaText(d: Delta | null): string {
  if (!d) return "No prior-period data to compare";
  const diff = d.current - d.previous;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff} vs previous period${d.change === null ? "" : ` (${sign}${Math.round(d.change * 100)}%)`}`;
}

function SafetyBenchmark() {
  const b = FIXTURE_BENCHMARK;
  return (
    <section aria-labelledby="bench-title" className="space-y-3 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="bench-title" className="text-base font-semibold text-[var(--color-jarvis-ink)]">
          Safety benchmark
        </h3>
        <Pill tone="warning">Fixture model · not AMD · not real-model</Pill>
      </div>
      <FixtureBenchmarkNotice />
      <p className="max-w-3xl text-sm text-[var(--color-warning)]">{b.disclaimer}</p>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Unsafe autonomous actions" value={String(b.unsafeAutonomousActions)} hint="CI gate: must stay 0" />
        <KpiCard label="Safe resolution rate" value={pct(b.safeResolutionRate)} hint={`${b.passed}/${b.totalCases} cases`} />
        <KpiCard label="Correct escalations" value={`${b.correctEscalations} / ${b.groundTruthEscalation}`} hint={pct(b.correctEscalationRate)} />
        <KpiCard label="Correct autonomous" value={`${b.correctAutonomousResolutions} / ${b.groundTruthAutonomous}`} hint="DC-S04 escalated conservatively" />
        <KpiCard label="Workflow success" value={pct(b.workflowSuccessRate)} />
        <KpiCard label="Verification success" value={pct(b.verificationSuccessRate)} />
      </dl>
      <details className="rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] px-4 py-2 text-sm shadow-card">
        <summary className="cursor-pointer font-medium text-[var(--color-jarvis-ink)]">Dataset pin</summary>
        <dl className="mt-2 space-y-2">
          <div>
            <dt className="text-xs text-[var(--color-jarvis-muted)]">Dataset</dt>
            <dd className="font-mono text-xs">
              {b.datasetId} v{b.datasetVersion} · {b.totalCases} cases · {b.conservativeEscalations} conservative escalation
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-jarvis-muted)]">SHA-256</dt>
            <dd className="break-all font-mono text-[11px]">{b.datasetSha256}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-jarvis-muted)]">Model / payments / data</dt>
            <dd className="text-xs text-[var(--color-jarvis-muted)]">
              {b.model} · {b.payments} · {b.data}
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
