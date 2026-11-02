// Merchant views (Analytics, Orders, Inbox) derived ONLY from records this UI actually holds:
// session cases (real /cases responses, including their engine audit) and the demo-store
// snapshot (GET /api/demo-store). Nothing here invents history, revenue or messages.
import type { AuditEvent, Case, CaseState } from "./case-types.ts";
import { customerReply, orderPaidMinor, type CustomerReply, type DemoStoreOrder, type DemoStoreSnapshot } from "./demo-store.ts";
import type { SessionCaseEntry } from "./session-store.ts";

// ---------------------------------------------------------------------------------------------
// Analytics

export type SourceFilter = "all" | "storefront" | "operations";
export type RangeFilter = "15m" | "1h" | "24h" | "session";

export const RANGE_LABELS: Record<RangeFilter, string> = {
  "15m": "Last 15 minutes",
  "1h": "Last hour",
  "24h": "Last 24 hours",
  session: "Whole session",
};
const RANGE_MS: Record<Exclude<RangeFilter, "session">, number> = { "15m": 15 * 60_000, "1h": 3_600_000, "24h": 86_400_000 };

export type OutcomeBucket = "resolved" | "escalated" | "closed" | "failed";
export const outcomeOf = (state: CaseState): OutcomeBucket | null =>
  state === "RESOLVED" ? "resolved" : state === "ESCALATED" ? "escalated" : state === "CLOSED_NO_ACTION" ? "closed" : state === "FAILED" ? "failed" : null;

export interface AiCallStat {
  stage: "Understanding" | "Decision";
  adapter: string;
  calls: number;
  errors: number;
  avgMs: number;
  maxMs: number;
}

export interface VolumeBucket {
  start: string;
  resolved: number;
  escalated: number;
  closed: number;
  failed: number;
}

export interface ActivityItem {
  caseId: string;
  orderId: string;
  at: string;
  state: CaseState;
  source: "operations" | "storefront";
  summary: string;
}

export interface Analytics {
  total: number;
  outcomes: Record<OutcomeBucket, number>;
  /** Share of cases JARVIS closed autonomously (resolved with verified refund, or correctly closed). */
  autonomousRate: number | null;
  /** Sum of refunds observed by read-back verification. Simulated gateway; synthetic data. */
  verifiedRefundMinor: Record<string, number>;
  /** Refund proposals the AI made that policy denied (money that did not move). */
  proposalsBlocked: number;
  execution: { attempted: number; verified: number; unverified: number };
  aiCalls: AiCallStat[];
  volume: VolumeBucket[];
  bucketMinutes: number;
  activity: ActivityItem[];
}

export function filterHistory(history: SessionCaseEntry[], source: SourceFilter, range: RangeFilter, now: Date): SessionCaseEntry[] {
  const floor = range === "session" ? -Infinity : now.getTime() - RANGE_MS[range];
  return history.filter((h) => (source === "all" || (h.source ?? "operations") === source) && Date.parse(h.submittedAt) >= floor);
}

const aiStage = (t: string): AiCallStat["stage"] | null =>
  t === "UNDERSTANDING_CALL" ? "Understanding" : t === "MODEL_CALL" ? "Decision" : null;

function latencyOf(ev: AuditEvent): { adapter: string; latencyMs: number; error: boolean } | null {
  const d = ev.data as { adapter?: unknown; latencyMs?: unknown; error?: unknown } | null;
  if (!d || typeof d.adapter !== "string" || typeof d.latencyMs !== "number") return null;
  return { adapter: d.adapter, latencyMs: d.latencyMs, error: d.error !== undefined };
}

/** Bucket width that keeps the chart readable for the span actually covered. */
export function bucketMinutesFor(spanMs: number): number {
  const mins = spanMs / 60_000;
  if (mins <= 15) return 1;
  if (mins <= 60) return 5;
  if (mins <= 6 * 60) return 30;
  return 60;
}

export function deriveAnalytics(entries: SessionCaseEntry[]): Analytics {
  const outcomes: Record<OutcomeBucket, number> = { resolved: 0, escalated: 0, closed: 0, failed: 0 };
  const verifiedRefundMinor: Record<string, number> = {};
  const execution = { attempted: 0, verified: 0, unverified: 0 };
  const ai = new Map<string, { stage: AiCallStat["stage"]; adapter: string; lat: number[]; errors: number }>();
  let proposalsBlocked = 0;

  for (const e of entries) {
    const c = e.caseData;
    const o = outcomeOf(c.state);
    if (o) outcomes[o] += 1;
    if (c.state === "RESOLVED" && c.verification?.verified && c.verification.observedRefund) {
      const r = c.verification.observedRefund;
      verifiedRefundMinor[r.currency] = (verifiedRefundMinor[r.currency] ?? 0) + r.amountMinor;
    }
    if (c.proposal?.action === "REFUND_DUPLICATE" && c.authorization?.outcome === "DENY") proposalsBlocked += 1;
    if (c.action) {
      execution.attempted += 1;
      if (c.verification?.verified) execution.verified += 1;
      else execution.unverified += 1;
    }
    for (const ev of c.audit) {
      const stage = aiStage(ev.type);
      const l = stage && latencyOf(ev);
      if (!stage || !l) continue;
      const key = `${stage}|${l.adapter}`;
      const s = ai.get(key) ?? { stage, adapter: l.adapter, lat: [], errors: 0 };
      s.lat.push(l.latencyMs);
      if (l.error) s.errors += 1;
      ai.set(key, s);
    }
  }

  const aiCalls: AiCallStat[] = [...ai.values()].map((s) => ({
    stage: s.stage,
    adapter: s.adapter,
    calls: s.lat.length,
    errors: s.errors,
    avgMs: Math.round(s.lat.reduce((a, b) => a + b, 0) / s.lat.length),
    maxMs: Math.max(...s.lat),
  }));

  const times = entries.map((e) => Date.parse(e.submittedAt)).filter(Number.isFinite);
  const bucketMinutes = times.length ? bucketMinutesFor(Math.max(...times) - Math.min(...times)) : 1;
  const volume = bucketVolume(entries, bucketMinutes);

  const total = entries.length;
  const autonomous = outcomes.resolved + outcomes.closed;
  const activity: ActivityItem[] = [...entries]
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))
    .slice(0, 8)
    .map((e) => ({
      caseId: e.id,
      orderId: e.orderId,
      at: e.submittedAt,
      state: e.state,
      source: e.source ?? "operations",
      summary: activitySummary(e.caseData),
    }));

  return {
    total,
    outcomes,
    autonomousRate: total ? autonomous / total : null,
    verifiedRefundMinor,
    proposalsBlocked,
    execution,
    aiCalls,
    volume,
    bucketMinutes,
    activity,
  };
}

function bucketVolume(entries: SessionCaseEntry[], bucketMinutes: number): VolumeBucket[] {
  if (!entries.length) return [];
  const width = bucketMinutes * 60_000;
  const keyOf = (iso: string) => Math.floor(Date.parse(iso) / width) * width;
  const keys = entries.map((e) => keyOf(e.submittedAt));
  const first = Math.min(...keys);
  const last = Math.max(...keys);
  const out: VolumeBucket[] = [];
  for (let k = first; k <= last; k += width) out.push({ start: new Date(k).toISOString(), resolved: 0, escalated: 0, closed: 0, failed: 0 });
  for (const e of entries) {
    const o = outcomeOf(e.state);
    if (o) out[(keyOf(e.submittedAt) - first) / width][o] += 1;
  }
  return out;
}

function activitySummary(c: Case): string {
  if (c.state === "RESOLVED" && c.verification?.verified) return "Refund executed (simulated) and verified by read-back";
  if (c.state === "ESCALATED")
    return c.proposal?.action === "REFUND_DUPLICATE" && c.authorization?.outcome === "DENY"
      ? "AI proposed a refund; policy denied it; routed to a human"
      : "Routed to a human for review";
  if (c.state === "CLOSED_NO_ACTION") return "No duplicate to refund; closed without action";
  if (c.state === "FAILED") return "Failed safely; no refund confirmed";
  return "In progress";
}

// ---------------------------------------------------------------------------------------------
// Orders (demo store joined with session cases)

export type PaymentState = "Paid" | "Charged twice" | "Paid, extra charge refunded" | "Partially refunded" | "Unpaid";
export type RefundState = "None" | "Refunded before JARVIS" | "Refunded by JARVIS (simulated)" | "Refund blocked" | "Refund not confirmed";
export type VerificationState = "Verified" | "Not verified" | "Not executed" | "—";
export type OrderStatusFilter = "all" | "needs-review" | "refunded" | "closed" | "no-case";

export const ORDER_FILTER_LABELS: Record<OrderStatusFilter, string> = {
  all: "All",
  "needs-review": "Needs review",
  refunded: "Refunded",
  closed: "Closed, no action",
  "no-case": "No case yet",
};

export interface OrderRow {
  order: DemoStoreOrder;
  paymentState: PaymentState;
  refundState: RefundState;
  /** Most recent session case for this order, if any. */
  latestCase: SessionCaseEntry | null;
  caseCount: number;
  resolution: CaseState | null;
  verification: VerificationState;
}

/** Payment state of the seeded order as the backend reports it (not mutated by demo runs). */
export function paymentStateOf(o: DemoStoreOrder): PaymentState {
  const succeeded = o.charges.filter((c) => c.status === "SUCCEEDED");
  if (!succeeded.length) return "Unpaid";
  const net = orderPaidMinor(o);
  if (net > o.totalMinor) return "Charged twice";
  if (succeeded.some((c) => c.refundedMinor > 0)) return net === o.totalMinor ? "Paid, extra charge refunded" : "Partially refunded";
  return "Paid";
}

export function verificationStateOf(c: Case | null): VerificationState {
  if (!c) return "—";
  if (!c.action) return "Not executed";
  return c.verification?.verified ? "Verified" : "Not verified";
}

function refundStateOf(o: DemoStoreOrder, c: Case | null): RefundState {
  if (c?.state === "RESOLVED" && c.verification?.verified) return "Refunded by JARVIS (simulated)";
  if (c?.action && !c.verification?.verified) return "Refund not confirmed";
  if (c?.proposal?.action === "REFUND_DUPLICATE" && c.authorization?.outcome === "DENY") return "Refund blocked";
  if (o.charges.some((ch) => ch.refundedMinor > 0)) return "Refunded before JARVIS";
  return "None";
}

export function buildOrderRows(snapshot: DemoStoreSnapshot, history: SessionCaseEntry[]): OrderRow[] {
  return snapshot.orders.map((order) => {
    const cases = history.filter((h) => h.orderId === order.orderId);
    const latest = cases[0] ?? null; // history is newest-first
    return {
      order,
      paymentState: paymentStateOf(order),
      refundState: refundStateOf(order, latest?.caseData ?? null),
      latestCase: latest,
      caseCount: cases.length,
      resolution: latest?.state ?? null,
      verification: verificationStateOf(latest?.caseData ?? null),
    };
  });
}

export function filterOrderRows(rows: OrderRow[], query: string, status: OrderStatusFilter): OrderRow[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  return rows.filter((r) => {
    if (q && ![r.order.orderId, r.order.customerName, r.order.customerId].some((v) => v.toLowerCase().includes(q))) return false;
    switch (status) {
      case "all":
        return true;
      case "needs-review":
        return r.resolution === "ESCALATED" || r.resolution === "FAILED";
      case "refunded":
        return r.refundState === "Refunded by JARVIS (simulated)" || r.refundState === "Refunded before JARVIS";
      case "closed":
        return r.resolution === "CLOSED_NO_ACTION";
      case "no-case":
        return r.latestCase === null;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Support inbox: one conversation per order that has at least one recorded request.

export type ThreadStatus = "Needs human" | "Resolved" | "Closed" | "Failed" | "In progress";
export type InboxFilter = "all" | "needs-human" | "resolved" | "closed";

export const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  all: "All",
  "needs-human": "Needs human",
  resolved: "Resolved",
  closed: "Closed",
};

export type ThreadMessage =
  | { kind: "customer"; caseId: string; at: string; text: string; via: "storefront" | "operations" }
  /** Reply derived from the recorded case outcome. `delivered` is true only when the demo storefront displayed it. */
  | { kind: "reply"; caseId: string; at: string; reply: CustomerReply; delivered: boolean };

export interface InboxThread {
  orderId: string;
  customerId: string;
  customerName: string;
  status: ThreadStatus;
  lastAt: string;
  lastText: string;
  messages: ThreadMessage[];
  cases: SessionCaseEntry[];
  latest: SessionCaseEntry;
}

export function threadStatusOf(state: CaseState): ThreadStatus {
  if (state === "ESCALATED") return "Needs human";
  if (state === "RESOLVED") return "Resolved";
  if (state === "CLOSED_NO_ACTION") return "Closed";
  if (state === "FAILED") return "Failed";
  return "In progress";
}

export function buildInboxThreads(history: SessionCaseEntry[], snapshot: DemoStoreSnapshot | null): InboxThread[] {
  const byOrder = new Map<string, SessionCaseEntry[]>();
  for (const h of history) byOrder.set(h.orderId, [...(byOrder.get(h.orderId) ?? []), h]);
  const threads: InboxThread[] = [];
  for (const [orderId, cases] of byOrder) {
    const chronological = [...cases].sort((a, b) => Date.parse(a.caseData.createdAt) - Date.parse(b.caseData.createdAt));
    const messages: ThreadMessage[] = chronological.flatMap((e) => [
      { kind: "customer" as const, caseId: e.id, at: e.caseData.createdAt, text: e.caseData.request.message, via: e.source ?? "operations" },
      {
        kind: "reply" as const,
        caseId: e.id,
        at: e.caseData.updatedAt,
        reply: customerReply(e.caseData),
        delivered: e.source === "storefront",
      },
    ]);
    const latest = chronological[chronological.length - 1];
    const order = snapshot?.orders.find((o) => o.orderId === orderId);
    const last = messages[messages.length - 1];
    threads.push({
      orderId,
      customerId: latest.customerId,
      customerName: order?.customerName ?? latest.caseData.evidence?.customer.name ?? latest.customerId,
      status: threadStatusOf(latest.state),
      lastAt: latest.caseData.updatedAt,
      lastText: last.kind === "reply" ? last.reply.title : last.text,
      messages,
      cases: chronological,
      latest,
    });
  }
  return threads.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

export function filterThreads(threads: InboxThread[], query: string, filter: InboxFilter): InboxThread[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  return threads.filter((t) => {
    if (q && ![t.orderId, t.customerName, t.customerId, t.lastText].some((v) => v.toLowerCase().includes(q))) return false;
    if (filter === "needs-human") return t.status === "Needs human" || t.status === "Failed";
    if (filter === "resolved") return t.status === "Resolved";
    if (filter === "closed") return t.status === "Closed";
    return true;
  });
}

export interface CopilotBrief {
  proposal: { action: string; rationale: string; confidence: number } | null;
  policyRefs: { id: string; text: string }[];
  checks: { passed: number; total: number; failed: { rule: string; detail: string }[] };
  approval: { required: boolean; text: string };
  verification: VerificationState;
  evidence: { label: string; value: string }[];
}

/** What the Copilot pane shows: the engine's own records, with the AI proposal kept separate from the decision. */
export function copilotBrief(c: Case): CopilotBrief {
  const auth = c.authorization;
  const failed = auth?.checks.filter((k) => !k.passed).map((k) => ({ rule: k.rule, detail: k.detail })) ?? [];
  const sections = c.evidence?.policy.sections ?? [];
  const policyRefs = sections.filter((s) => c.proposal?.evidenceRefs.includes(s.id));
  let approval: CopilotBrief["approval"];
  if (c.state === "ESCALATED")
    approval = { required: true, text: "A person must review this case. JARVIS will not move money on it." };
  else if (c.state === "FAILED")
    approval = { required: true, text: "A person must follow up. No refund is confirmed." };
  else if (c.state === "RESOLVED")
    approval = { required: false, text: "Within autonomous authority: policy approved and the refund was verified." };
  else if (c.state === "CLOSED_NO_ACTION") approval = { required: false, text: "Nothing to approve: no refund is owed." };
  else approval = { required: true, text: "Case not finished." };

  const ev = c.evidence;
  const evidence = ev
    ? [
        { label: "Charges on record", value: String(ev.transactions.length) },
        { label: "Duplicate groups", value: String(ev.duplicateGroups.length) },
        { label: "Prior refunds", value: String(ev.refunds.length) },
        { label: "Financial status", value: ev.financial.status.replaceAll("_", " ").toLowerCase() },
        { label: "Contradictions", value: ev.contradictions.length ? ev.contradictions.join("; ") : "none" },
      ]
    : [];
  return {
    proposal: c.proposal ? { action: c.proposal.action, rationale: c.proposal.rationale, confidence: c.proposal.confidence } : null,
    policyRefs,
    checks: { passed: auth?.checks.filter((k) => k.passed).length ?? 0, total: auth?.checks.length ?? 0, failed },
    approval,
    verification: verificationStateOf(c),
    evidence,
  };
}

export type OrderSortKey = "order" | "customer" | "value" | "refund" | "resolution";
export type SortDir = "asc" | "desc";

/** Stable sort of order rows; ties keep order-number order. */
export function sortOrderRows(rows: OrderRow[], key: OrderSortKey, dir: SortDir): OrderRow[] {
  const val = (r: OrderRow): string | number =>
    key === "order"
      ? Number(r.order.orderId)
      : key === "customer"
        ? r.order.customerName.toLowerCase()
        : key === "value"
          ? r.order.totalMinor
          : key === "refund"
            ? r.refundState
            : (r.resolution ?? "~");
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x < y) return -sign;
    if (x > y) return sign;
    return Number(a.order.orderId) - Number(b.order.orderId);
  });
}

export const isOrderStatusFilter = (v: string | undefined): v is OrderStatusFilter => !!v && v in ORDER_FILTER_LABELS;

export type LifecycleKey = "PROPOSED" | "APPROVED" | "EXECUTED" | "VERIFIED" | "ESCALATED";
export interface LifecycleStep {
  key: LifecycleKey;
  reached: boolean;
  detail: string;
}

/**
 * The distinct control-plane milestones, each read from its own record — never inferred from another:
 * PROPOSED (AI proposal exists) ≠ APPROVED (engine entered APPROVED after policy) ≠ EXECUTED (gateway
 * accepted) ≠ VERIFIED (read-back observed the refund). ESCALATED means a person must decide.
 */
export function lifecycleOf(c: Case): LifecycleStep[] {
  const entered = (s: string) => c.audit.some((e) => e.type === "STATE_TRANSITION" && e.to === s);
  // A replayed refund was executed by another case; this case executed nothing.
  const executed = c.action?.status === "ACCEPTED" && c.action.replayed !== true;
  const verified = !!c.verification?.verified;
  return [
    {
      key: "PROPOSED",
      reached: !!c.proposal,
      detail: c.proposal ? `AI proposed ${c.proposal.action.replaceAll("_", " ").toLowerCase()} (advisory)` : "No proposal recorded",
    },
    {
      key: "APPROVED",
      reached: entered("APPROVED"),
      detail: entered("APPROVED")
        ? `Policy ${c.authorization?.outcome ?? ""} · ${c.authorization?.checks.filter((k) => k.passed).length ?? 0}/${c.authorization?.checks.length ?? 0} checks`
        : c.authorization
          ? `Policy ${c.authorization.outcome}: not approved for execution`
          : "Policy not reached",
    },
    {
      key: "EXECUTED",
      reached: executed,
      detail: executed ? `Simulated gateway accepted ${c.action?.providerRefundId ?? "the refund"}` : c.action?.replayed ? `Gateway returned existing refund ${c.action.providerRefundId ?? ""}; nothing new executed` : c.action ? `Gateway: ${c.action.status}${c.action.error ? ` · ${c.action.error}` : ""}` : "Nothing sent to the gateway",
    },
    {
      key: "VERIFIED",
      reached: verified,
      detail: verified ? `Read-back observed ${c.verification?.observedRefund?.id ?? "the refund"}` : c.verification ? "Read-back did not confirm the refund" : "No read-back performed",
    },
    {
      key: "ESCALATED",
      reached: c.state === "ESCALATED" || c.state === "FAILED",
      detail: c.state === "ESCALATED" ? "Routed to a person; no money moved" : c.state === "FAILED" ? "Failed safely; a person must follow up" : "Not escalated",
    },
  ];
}

/** State transitions as the engine recorded them (case progression). */
export function progressionOf(c: Case): { state: string; at: string }[] {
  return c.audit.filter((e) => e.type === "STATE_TRANSITION" && e.to).map((e) => ({ state: e.to as string, at: e.at }));
}

// ---------------------------------------------------------------------------------------------
// Customers (demo store seed joined with recorded cases)

export interface CustomerRow {
  customerId: string;
  name: string;
  orders: number;
  orderValueMinor: number;
  currency: string;
  cases: number;
  pendingReview: number;
  latest: SessionCaseEntry | null;
}

/** Customers as the demo store seed defines them, joined with recorded cases. Nothing else is known about them. */
export function customerRows(snapshot: DemoStoreSnapshot, history: SessionCaseEntry[]): CustomerRow[] {
  const by = new Map<string, CustomerRow>();
  for (const o of snapshot.orders) {
    const row = by.get(o.customerId) ?? { customerId: o.customerId, name: o.customerName, orders: 0, orderValueMinor: 0, currency: o.currency, cases: 0, pendingReview: 0, latest: null };
    row.orders += 1;
    row.orderValueMinor += o.totalMinor;
    by.set(o.customerId, row);
  }
  for (const h of history) {
    const row = by.get(h.customerId);
    if (!row) continue;
    row.cases += 1;
    if (h.state === "ESCALATED" || h.state === "FAILED") row.pendingReview += 1;
    if (!row.latest) row.latest = h; // history is newest-first
  }
  return [...by.values()];
}
