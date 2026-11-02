// Analytics aggregation layer.
//   raw records  → AnalyticsRecord (normalized once, from real cases or the labelled sample set)
//   time filters → rangeWindow / inWindow
//   metrics      → summarize / compare
//   breakdowns   → timeSeries / outcome / refund / source / AI-call aggregates
// Visual components only render what these functions return. Nothing here invents values:
// every number is a count or sum over the records passed in.
import type { Case } from "./case-types.ts";
import type { SessionCaseEntry } from "./session-store.ts";

export type Outcome = "resolved" | "escalated" | "closed" | "failed" | "open";
export type RefundOutcome = "verified" | "blocked" | "not-confirmed" | "not-needed" | "none";
export type RecordSource = "storefront" | "operations" | "sample";

export interface AiCall {
  stage: "Understanding" | "Decision";
  adapter: string;
  /** null when not measured (sample records never carry latency). */
  latencyMs: number | null;
  error: boolean;
}

export interface AnalyticsRecord {
  id: string;
  orderId: string;
  customerId: string;
  /** Case completion time (ISO). */
  at: string;
  outcome: Outcome;
  source: RecordSource;
  workflow: "Duplicate-charge refund";
  refund: RefundOutcome;
  /** Refund amount observed by read-back (verified only), else 0. */
  refundMinor: number;
  currency: string;
  needsReview: boolean;
  aiCalls: AiCall[];
  /** Present only for real records, so drill-downs can open the evidence. */
  entry?: SessionCaseEntry;
}

export const OUTCOME_LABELS: Record<Outcome, string> = {
  resolved: "Resolved (verified)",
  escalated: "Escalated to a person",
  closed: "Closed, no action",
  failed: "Failed safely",
  open: "In progress",
};
export const OUTCOME_ORDER: Outcome[] = ["resolved", "escalated", "closed", "failed"];

export const REFUND_LABELS: Record<RefundOutcome, string> = {
  verified: "Refund verified",
  blocked: "Blocked by policy",
  "not-confirmed": "Refund not confirmed",
  "not-needed": "No refund owed",
  none: "No refund proposed",
};
export const REFUND_ORDER: RefundOutcome[] = ["verified", "blocked", "not-confirmed", "not-needed", "none"];

// ---------------------------------------------------------------------------------------------
// Raw records

export function outcomeOfCase(c: Case): Outcome {
  switch (c.state) {
    case "RESOLVED":
      return "resolved";
    case "ESCALATED":
      return "escalated";
    case "CLOSED_NO_ACTION":
      return "closed";
    case "FAILED":
      return "failed";
    default:
      return "open";
  }
}

export function refundOutcomeOfCase(c: Case): RefundOutcome {
  if (c.state === "RESOLVED" && c.verification?.verified && c.verification.observedRefund) return "verified";
  if (c.action && !c.verification?.verified) return "not-confirmed";
  if (c.proposal?.action === "REFUND_DUPLICATE" && c.authorization?.outcome === "DENY") return "blocked";
  if (c.state === "CLOSED_NO_ACTION") return "not-needed";
  return "none";
}

function aiCallsOf(c: Case): AiCall[] {
  const out: AiCall[] = [];
  for (const ev of c.audit) {
    if (ev.type !== "UNDERSTANDING_CALL" && ev.type !== "MODEL_CALL") continue;
    const d = ev.data as { adapter?: unknown; latencyMs?: unknown; error?: unknown } | null;
    if (!d || typeof d.adapter !== "string") continue;
    out.push({
      stage: ev.type === "MODEL_CALL" ? "Decision" : "Understanding",
      adapter: d.adapter,
      latencyMs: typeof d.latencyMs === "number" ? d.latencyMs : null,
      error: d.error !== undefined,
    });
  }
  return out;
}

export function recordFromEntry(e: SessionCaseEntry): AnalyticsRecord {
  const c = e.caseData;
  const outcome = outcomeOfCase(c);
  const refund = refundOutcomeOfCase(c);
  const observed = refund === "verified" ? c.verification!.observedRefund! : null;
  return {
    id: e.id,
    orderId: e.orderId,
    customerId: e.customerId,
    at: e.submittedAt,
    outcome,
    source: e.source ?? "operations",
    workflow: "Duplicate-charge refund",
    refund,
    refundMinor: observed?.amountMinor ?? 0,
    currency: observed?.currency ?? c.evidence?.order.currency ?? "USD",
    needsReview: outcome === "escalated" || outcome === "failed",
    aiCalls: aiCallsOf(c),
    entry: e,
  };
}

// ---------------------------------------------------------------------------------------------
// Time filters

export type RangeId = "today" | "7d" | "30d" | "90d" | "all";
export const RANGE_OPTIONS: { id: RangeId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "all", label: "All available data" },
];

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface TimeWindow {
  start: number;
  end: number;
  /** Equal-length window immediately before; null for "all" (nothing precedes all data). */
  previous: { start: number; end: number } | null;
}

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function rangeWindow(range: RangeId, now: number, records: AnalyticsRecord[]): TimeWindow {
  if (range === "all") {
    const times = records.map((r) => Date.parse(r.at));
    return { start: times.length ? Math.min(...times) : now, end: now, previous: null };
  }
  const start = range === "today" ? startOfDay(now) : now - { "7d": 7, "30d": 30, "90d": 90 }[range] * DAY;
  const len = now - start;
  return { start, end: now, previous: { start: start - len, end: start } };
}

export const inWindow = (r: AnalyticsRecord, w: { start: number; end: number }) => {
  const t = Date.parse(r.at);
  return t >= w.start && t <= w.end;
};

// ---------------------------------------------------------------------------------------------
// Metrics

export interface Summary {
  cases: number;
  outcomes: Record<Outcome, number>;
  refunds: Record<RefundOutcome, number>;
  verifiedRefundMinor: Record<string, number>;
  /** (resolved + closed) / cases: cases JARVIS finished without a person. null with no cases. */
  autonomousRate: number | null;
  escalationRate: number | null;
  pendingReview: number;
  aiCalls: number;
  aiErrors: number;
  storefront: number;
}

export function summarize(records: AnalyticsRecord[]): Summary {
  const outcomes: Record<Outcome, number> = { resolved: 0, escalated: 0, closed: 0, failed: 0, open: 0 };
  const refunds: Record<RefundOutcome, number> = { verified: 0, blocked: 0, "not-confirmed": 0, "not-needed": 0, none: 0 };
  const verifiedRefundMinor: Record<string, number> = {};
  let pendingReview = 0;
  let aiCalls = 0;
  let aiErrors = 0;
  let storefront = 0;
  for (const r of records) {
    outcomes[r.outcome] += 1;
    refunds[r.refund] += 1;
    if (r.refund === "verified") verifiedRefundMinor[r.currency] = (verifiedRefundMinor[r.currency] ?? 0) + r.refundMinor;
    if (r.needsReview) pendingReview += 1;
    aiCalls += r.aiCalls.length;
    aiErrors += r.aiCalls.filter((a) => a.error).length;
    if (r.source === "storefront") storefront += 1;
  }
  const n = records.length;
  return {
    cases: n,
    outcomes,
    refunds,
    verifiedRefundMinor,
    autonomousRate: n ? (outcomes.resolved + outcomes.closed) / n : null,
    escalationRate: n ? outcomes.escalated / n : null,
    pendingReview,
    aiCalls,
    aiErrors,
    storefront,
  };
}

export interface Delta {
  current: number;
  previous: number;
  /** Fractional change; null when the previous period has no records (no honest baseline). */
  change: number | null;
}

/** Compare a metric with the previous equal-length window; only when that window holds records. */
export function compare(
  records: AnalyticsRecord[],
  w: TimeWindow,
  metric: (s: Summary) => number,
): Delta | null {
  if (!w.previous) return null;
  const prev = records.filter((r) => inWindow(r, w.previous!));
  if (prev.length === 0) return null;
  const current = metric(summarize(records.filter((r) => inWindow(r, w))));
  const previous = metric(summarize(prev));
  return { current, previous, change: previous === 0 ? null : (current - previous) / previous };
}

// ---------------------------------------------------------------------------------------------
// Breakdowns

export interface Bucket {
  start: number;
  end: number;
  label: string;
  counts: Record<Outcome, number>;
  total: number;
}

export type Granularity = "5min" | "hour" | "day" | "week";

export function granularityFor(range: RangeId, w: TimeWindow): Granularity {
  if (range === "today") return "hour";
  if (range === "7d" || range === "30d") return "day";
  if (range === "90d") return "week";
  const span = w.end - w.start;
  if (span <= 2 * HOUR) return "5min";
  if (span <= 2 * DAY) return "hour";
  if (span <= 60 * DAY) return "day";
  return "week";
}

const STEP: Record<Granularity, number> = { "5min": 300_000, hour: HOUR, day: DAY, week: 7 * DAY };

function bucketStart(t: number, g: Granularity): number {
  if (g === "day" || g === "week") return startOfDay(t);
  return Math.floor(t / STEP[g]) * STEP[g];
}

function bucketLabel(t: number, g: Granularity): string {
  const d = new Date(t);
  if (g === "day" || g === "week") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Contiguous buckets across the whole window (empty buckets included, so the axis never lies). */
export function timeSeries(records: AnalyticsRecord[], w: TimeWindow, g: Granularity): Bucket[] {
  const step = STEP[g];
  const first = bucketStart(w.start, g);
  const buckets: Bucket[] = [];
  for (let s = first; s <= w.end; s += step) {
    buckets.push({ start: s, end: s + step, label: bucketLabel(s, g), counts: { resolved: 0, escalated: 0, closed: 0, failed: 0, open: 0 }, total: 0 });
    if (buckets.length > 400) break; // guard against a pathological window
  }
  for (const r of records) {
    const t = Date.parse(r.at);
    if (t < w.start || t > w.end) continue;
    const i = Math.floor((t - first) / step);
    const b = buckets[Math.min(Math.max(i, 0), buckets.length - 1)];
    b.counts[r.outcome] += 1;
    b.total += 1;
  }
  return buckets;
}

export interface AiStageStat {
  stage: AiCall["stage"];
  adapter: string;
  calls: number;
  errors: number;
  measured: number;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export function aiStats(records: AnalyticsRecord[]): AiStageStat[] {
  const groups = new Map<string, AiCall[]>();
  for (const r of records) for (const a of r.aiCalls) groups.set(`${a.stage}|${a.adapter}`, [...(groups.get(`${a.stage}|${a.adapter}`) ?? []), a]);
  return [...groups.values()].map((calls) => {
    const lat = calls.map((c) => c.latencyMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
    return {
      stage: calls[0].stage,
      adapter: calls[0].adapter,
      calls: calls.length,
      errors: calls.filter((c) => c.error).length,
      measured: lat.length,
      avgMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      p95Ms: lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)] : null,
      maxMs: lat.length ? lat[lat.length - 1] : null,
    };
  });
}

export interface DrillFilter {
  outcome?: Outcome;
  refund?: RefundOutcome;
  source?: RecordSource;
  reviewOnly?: boolean;
}

export function drill(records: AnalyticsRecord[], f: DrillFilter): AnalyticsRecord[] {
  return records
    .filter(
      (r) =>
        (!f.outcome || r.outcome === f.outcome) &&
        (!f.refund || r.refund === f.refund) &&
        (!f.source || r.source === f.source) &&
        (!f.reviewOnly || r.needsReview),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function describeDrill(f: DrillFilter): string | null {
  const parts = [
    f.outcome && OUTCOME_LABELS[f.outcome],
    f.refund && REFUND_LABELS[f.refund],
    f.source && { storefront: "Demo store", operations: "Console", sample: "Sample" }[f.source],
    f.reviewOnly && "Needs review",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
