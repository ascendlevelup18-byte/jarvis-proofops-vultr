import { useMemo, useState } from "react";
import { Card, EmptyState, ErrorNotice, LoadingRows, PageHeader, Pill, Segmented, type PillTone } from "../components/ui/Primitives.tsx";
import { StateBadge } from "../components/ui/StateBadge.tsx";
import { btn, inputCls } from "../components/ui/styles.ts";
import {
  buildOrderRows,
  filterOrderRows,
  isOrderStatusFilter,
  ORDER_FILTER_LABELS,
  sortOrderRows,
  verificationStateOf,
  type OrderRow,
  type OrderSortKey,
  type OrderStatusFilter,
  type PaymentState,
  type RefundState,
  type SortDir,
  type VerificationState,
} from "../lib/commerce.ts";
import { describeOrderBalance, type DemoStoreOrder, type DemoStoreSnapshot } from "../lib/demo-store.ts";
import { formatMinor } from "../lib/money.ts";
import { explainDecision } from "../lib/proof.ts";
import type { SessionCaseEntry } from "../lib/session-store.ts";

export type StoreLoad = { status: "idle" | "loading" } | { status: "error"; error: string };

const PAYMENT_TONE: Record<PaymentState, PillTone> = {
  Paid: "success",
  "Charged twice": "warning",
  "Paid, extra charge refunded": "neutral",
  "Partially refunded": "neutral",
  Unpaid: "danger",
};
const REFUND_TONE: Record<RefundState, PillTone> = {
  None: "neutral",
  "Refunded before JARVIS": "neutral",
  "Refunded by JARVIS (simulated)": "success",
  "Refund blocked": "warning",
  "Refund not confirmed": "danger",
};
const VERIFY_TONE: Record<VerificationState, PillTone> = {
  Verified: "success",
  "Not verified": "danger",
  "Not executed": "neutral",
  "—": "neutral",
};

const COLUMNS: { label: string; sort?: OrderSortKey; compact: boolean }[] = [
  { label: "Order", sort: "order", compact: true },
  { label: "Customer", sort: "customer", compact: true },
  { label: "Value", sort: "value", compact: true },
  { label: "Payment", compact: false },
  { label: "Refund", sort: "refund", compact: true },
  { label: "JARVIS case", compact: false },
  { label: "Outcome", sort: "resolution", compact: true },
  { label: "Verification", compact: false },
];

export function OrdersPage({
  snapshot,
  load,
  onReload,
  history,
  onOpenCase,
  onRunOrder,
  selectedId,
  onSelect,
  initialStatus,
  initialQuery,
}: {
  snapshot: DemoStoreSnapshot | null;
  load: StoreLoad;
  onReload: () => void;
  history: SessionCaseEntry[];
  onOpenCase: (e: SessionCaseEntry) => void;
  /** Sends the order's fixed customer request through POST /cases (a real case). */
  onRunOrder: (o: DemoStoreOrder) => Promise<void>;
  /** Order shown in the detail drawer (deep-linked as #/orders/<id>). */
  selectedId: string | null;
  onSelect: (orderId: string | null) => void;
  initialStatus?: string;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [status, setStatus] = useState<OrderStatusFilter>(isOrderStatusFilter(initialStatus) ? initialStatus : "all");
  const [sort, setSort] = useState<{ key: OrderSortKey; dir: SortDir }>({ key: "order", dir: "asc" });
  const rows = useMemo(() => (snapshot ? buildOrderRows(snapshot, history) : []), [snapshot, history]);
  const visible = sortOrderRows(filterOrderRows(rows, query, status), sort.key, sort.dir);
  const selected = rows.find((r) => r.order.orderId === selectedId) ?? null;
  const compact = !!selected;
  const cols = COLUMNS.filter((c) => !compact || c.compact);
  const toggleSort = (key: OrderSortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));

  return (
    <div className="motion-fade-in space-y-4">
      <PageHeader
        title="Orders"
        description={
          snapshot ? (
            <>
              {snapshot.store.name} · {snapshot.orders.length} orders from <code className="text-xs">GET /api/demo-store</code>, joined with recorded JARVIS cases. Synthetic data, simulated
              payments; fulfilment is not modelled, so no fulfilment status is shown.
            </>
          ) : (
            "Orders from the demo store on the JARVIS backend."
          )
        }
      />

      {load.status === "error" && <ErrorNotice onRetry={onReload}>Could not load the demo store: {load.error}</ErrorNotice>}
      {!snapshot && load.status === "loading" && <LoadingRows label="Loading orders" />}
      {!snapshot && load.status === "idle" && (
        <EmptyState
          title="Demo store not loaded"
          body="Orders are read from the backend's seeded demo store."
          action={
            <button type="button" className={btn.primary} onClick={onReload}>
              Load orders
            </button>
          }
        />
      )}

      {snapshot && selectedId && !selected && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning-surface)] px-4 py-2.5 text-sm text-[var(--color-warning)]">
          Order #{selectedId} is not in the demo store. It has orders {snapshot.orders.map((o) => `#${o.orderId}`).join(", ")}.
          <button type="button" className={btn.ghost} onClick={() => onSelect(null)}>
            Dismiss
          </button>
        </div>
      )}

      {snapshot && (
        <div className={`grid gap-4 ${selected ? "xl:grid-cols-[minmax(0,1fr)_420px]" : ""}`}>
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-48 flex-1 sm:max-w-xs">
                <label htmlFor="orders-search" className="sr-only">
                  Search orders
                </label>
                <input id="orders-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search order, customer…" className={inputCls} />
              </div>
              <Segmented
                label="Order status"
                value={status}
                onChange={setStatus}
                options={(Object.keys(ORDER_FILTER_LABELS) as OrderStatusFilter[]).map((v) => ({ value: v, label: ORDER_FILTER_LABELS[v] }))}
              />
              <span className="ml-auto text-xs text-[var(--color-jarvis-faint)]" aria-live="polite">
                {visible.length} of {rows.length} orders
              </span>
            </div>

            {visible.length === 0 ? (
              <EmptyState title="No orders match" body="Clear the search or choose another status filter." />
            ) : (
              <>
                {/* Table from md up; cards on narrow screens. */}
                <div className="hidden overflow-x-auto rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-card md:block">
                  <table className={`w-full text-left text-sm ${compact ? "min-w-[520px]" : "min-w-[860px]"}`}>
                    <caption className="sr-only">Demo store orders with their JARVIS case state</caption>
                    <thead className="border-b border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)] text-xs text-[var(--color-jarvis-muted)]">
                      <tr>
                        {cols.map((c) => (
                          <th
                            key={c.label}
                            scope="col"
                            aria-sort={c.sort && sort.key === c.sort ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                            className="whitespace-nowrap px-3 py-2 font-medium"
                          >
                            {c.sort ? (
                              <button type="button" onClick={() => toggleSort(c.sort!)} className="inline-flex items-center gap-1 hover:text-[var(--color-jarvis-ink)]">
                                {c.label}
                                <span aria-hidden className="text-[10px]">
                                  {sort.key === c.sort ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                                </span>
                              </button>
                            ) : (
                              c.label
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-jarvis-border)]">
                      {visible.map((r) => (
                        <OrderTableRow key={r.order.orderId} row={r} compact={compact} selected={r.order.orderId === selectedId} onSelect={() => onSelect(r.order.orderId)} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul aria-label="Orders" className="space-y-2 md:hidden">
                  {visible.map((r) => (
                    <li key={r.order.orderId}>
                      <button
                        type="button"
                        onClick={() => onSelect(r.order.orderId)}
                        aria-current={r.order.orderId === selectedId ? "true" : undefined}
                        className="block w-full rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] p-3 text-left shadow-card"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[var(--color-deterministic-accent)]">#{r.order.orderId}</span>
                          <span className="tabular-nums">{formatMinor(r.order.totalMinor, r.order.currency)}</span>
                        </span>
                        <span className="mt-0.5 block text-sm">{r.order.customerName}</span>
                        <span className="mt-2 flex flex-wrap gap-1.5">
                          <Pill tone={PAYMENT_TONE[r.paymentState]}>{r.paymentState}</Pill>
                          <Pill tone={REFUND_TONE[r.refundState]}>{r.refundState}</Pill>
                          {r.resolution && <StateBadge state={r.resolution} />}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="text-xs text-[var(--color-jarvis-faint)]">
              Payment state is the seeded record. Each JARVIS run uses a fresh copy of the store, so a simulated refund shows in the Refund column, not in the seed.
            </p>
          </div>

          {selected && <OrderDetail row={selected} history={history} onClose={() => onSelect(null)} onOpenCase={onOpenCase} onRunOrder={onRunOrder} />}
        </div>
      )}
    </div>
  );
}

function OrderTableRow({ row, selected, compact, onSelect }: { row: OrderRow; selected: boolean; compact: boolean; onSelect: () => void }) {
  const o = row.order;
  return (
    <tr onClick={onSelect} className={`cursor-pointer ${selected ? "bg-[var(--color-deterministic)]" : "hover:bg-[var(--color-jarvis-surface-2)]"}`}>
      <td className="whitespace-nowrap px-3 py-2.5">
        <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} className="font-semibold text-[var(--color-deterministic-accent)] hover:underline">
          #{o.orderId}
        </button>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5">
        <span className="text-[var(--color-jarvis-ink)]">{o.customerName}</span>
        {!compact && <span className="ml-1 font-mono text-[11px] text-[var(--color-jarvis-faint)]">{o.customerId}</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{formatMinor(o.totalMinor, o.currency)}</td>
      {!compact && (
        <td className="px-3 py-2.5">
          <Pill tone={PAYMENT_TONE[row.paymentState]}>{row.paymentState}</Pill>
        </td>
      )}
      <td className="px-3 py-2.5">
        <Pill tone={REFUND_TONE[row.refundState]}>{row.refundState}</Pill>
      </td>
      {!compact && (
        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-[var(--color-jarvis-muted)]">
          {row.latestCase ? `${row.latestCase.id.slice(0, 13)}…${row.caseCount > 1 ? ` (+${row.caseCount - 1})` : ""}` : "—"}
        </td>
      )}
      <td className="px-3 py-2.5">{row.resolution ? <StateBadge state={row.resolution} /> : <span className="text-[var(--color-jarvis-faint)]">No case</span>}</td>
      {!compact && (
        <td className="px-3 py-2.5">
          <Pill tone={VERIFY_TONE[row.verification]}>{row.verification}</Pill>
        </td>
      )}
    </tr>
  );
}

function OrderDetail({
  row,
  history,
  onClose,
  onOpenCase,
  onRunOrder,
}: {
  row: OrderRow;
  history: SessionCaseEntry[];
  onClose: () => void;
  onOpenCase: (e: SessionCaseEntry) => void;
  onRunOrder: (o: DemoStoreOrder) => Promise<void>;
}) {
  const o = row.order;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cases = history.filter((h) => h.orderId === o.orderId);
  const c = row.latestCase?.caseData ?? null;

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await onRunOrder(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <aside aria-label={`Order ${o.orderId} details`} className="space-y-3">
      <Card
        title={`Order #${o.orderId}`}
        aside={
          <button type="button" onClick={onClose} className={btn.ghost} aria-label="Close order details">
            Close
          </button>
        }
      >
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Customer" value={`${o.customerName} · ${o.customerId}`} />
          <Field label="Placed" value={new Date(o.placedAt).toLocaleString()} />
          <Field label="Order value" value={formatMinor(o.totalMinor, o.currency)} />
          <Field label="Payment" value={row.paymentState} />
          <Field label="Refund" value={row.refundState} />
          <Field label="Verification" value={row.verification} />
        </dl>
        <p className="mt-2 text-xs text-[var(--color-jarvis-muted)]">{describeOrderBalance(o)}</p>
        <table className="mt-3 w-full text-left text-xs">
          <caption className="sr-only">Payment records on this order</caption>
          <thead className="text-[var(--color-jarvis-muted)]">
            <tr>
              <th className="py-1 font-medium">Payment record</th>
              <th className="py-1 font-medium">Status</th>
              <th className="py-1 text-right font-medium">Amount</th>
              <th className="py-1 text-right font-medium">Refunded</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-jarvis-border)] tabular-nums">
            {o.charges.map((ch) => (
              <tr key={ch.id}>
                <td className="py-1.5 font-mono">{ch.id}</td>
                <td className="py-1.5">{ch.status.toLowerCase()}</td>
                <td className="py-1.5 text-right">{formatMinor(ch.amountMinor, ch.currency)}</td>
                <td className="py-1.5 text-right">{formatMinor(ch.refundedMinor, ch.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Customer request" aside="Fixed demo message">
        <blockquote className="rounded-md bg-[var(--color-jarvis-surface-2)] px-3 py-2 text-sm text-[var(--color-jarvis-ink)]">{o.supportRequest.message}</blockquote>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={btn.secondary} disabled={running} onClick={run}>
            {running ? "Running JARVIS…" : "Run JARVIS on this request"}
          </button>
          <span className="text-xs text-[var(--color-jarvis-faint)]">Real POST /cases · simulated payments</span>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </Card>

      <Card title="Linked JARVIS cases" aside={`${row.caseCount} recorded`}>
        {row.caseCount === 0 || !row.latestCase ? (
          <p className="text-sm text-[var(--color-jarvis-muted)]">No case yet. Run JARVIS above, or request a refund from the demo store.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StateBadge state={row.latestCase.state} />
              <span className="font-mono text-[11px] text-[var(--color-jarvis-faint)]">{row.latestCase.id}</span>
            </div>
            {c?.evidence && (
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <Field label="Financial status" value={c.evidence.financial.status.replaceAll("_", " ").toLowerCase()} />
                <Field label="Duplicate groups" value={String(c.evidence.duplicateGroups.length)} />
                <Field label="Contradictions" value={c.evidence.contradictions.length ? c.evidence.contradictions.join("; ") : "none"} />
                <Field
                  label="Policy"
                  value={c.authorization ? `${c.authorization.outcome} · ${c.authorization.checks.filter((k) => k.passed).length}/${c.authorization.checks.length} checks` : "not evaluated"}
                />
              </dl>
            )}
            <button type="button" className={btn.primary} onClick={() => onOpenCase(row.latestCase!)}>
              Open case evidence
            </button>
            <div>
              <h4 className="mb-1.5 text-xs font-semibold text-[var(--color-jarvis-muted)]">Decision history</h4>
              <ol aria-label="Decision history" className="space-y-2 border-l border-[var(--color-jarvis-border)] pl-3">
                {cases.map((e) => (
                  <li key={e.id} className="text-xs">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="tabular-nums text-[var(--color-jarvis-faint)]">{new Date(e.submittedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      <StateBadge state={e.state} />
                      <span className="text-[var(--color-jarvis-faint)]">{e.source === "storefront" ? "demo store" : "console"}</span>
                    </p>
                    <p className="mt-0.5 text-[var(--color-jarvis-ink)]">{explainDecision(e.caseData).points[0] ?? "—"}</p>
                    <p className="text-[var(--color-jarvis-muted)]">
                      Verification: {verificationStateOf(e.caseData)} ·{" "}
                      <button type="button" className="text-[var(--color-deterministic-accent)] hover:underline" onClick={() => onOpenCase(e)}>
                        Audit trail ({e.caseData.audit.length} events)
                      </button>
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </Card>
    </aside>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--color-jarvis-muted)]">{label}</dt>
      <dd className="break-words text-[var(--color-jarvis-ink)]">{value}</dd>
    </div>
  );
}
