import { useMemo, useState } from "react";
import { EmptyState, ErrorNotice, LoadingRows, PageHeader } from "../components/ui/Primitives.tsx";
import { StateBadge } from "../components/ui/StateBadge.tsx";
import { btn, inputCls } from "../components/ui/styles.ts";
import { customerRows } from "../lib/commerce.ts";
import type { DemoStoreSnapshot } from "../lib/demo-store.ts";
import { formatMinor } from "../lib/money.ts";
import type { SessionCaseEntry } from "../lib/session-store.ts";
import type { StoreLoad } from "./OrdersPage.tsx";

export function CustomersPage({
  snapshot,
  load,
  onReload,
  history,
  onViewOrders,
}: {
  snapshot: DemoStoreSnapshot | null;
  load: StoreLoad;
  onReload: () => void;
  history: SessionCaseEntry[];
  onViewOrders: (customerId: string) => void;
}) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => (snapshot ? customerRows(snapshot, history) : []), [snapshot, history]);
  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.customerId.toLowerCase().includes(needle));
  return (
    <div className="motion-fade-in space-y-4">
      <PageHeader title="Customers" description="Synthetic demo customers and their recorded cases." />
      {load.status === "error" && <ErrorNotice onRetry={onReload}>Could not load the demo store: {load.error}</ErrorNotice>}
      {!snapshot && load.status === "loading" && <LoadingRows label="Loading customers" />}
      {snapshot && (
        <>
          <div className="max-w-xs">
            <label htmlFor="customer-search" className="sr-only">
              Search customers
            </label>
            <input id="customer-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or ID" className={inputCls} />
          </div>
          {visible.length === 0 ? (
            <EmptyState title="No customers match" body="Clear the search to see every customer." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-card">
              <table className="w-full min-w-[640px] text-left text-sm">
                <caption className="sr-only">Customers</caption>
                <thead className="border-b border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)] text-xs text-[var(--color-jarvis-muted)]">
                  <tr>
                    {["Customer", "Orders", "Order value (synthetic)", "Cases", "Pending review", "Latest case", ""].map((h) => (
                      <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-jarvis-border)]">
                  {visible.map((r) => (
                    <tr key={r.customerId}>
                      <td className="px-3 py-2.5">
                        <span className="font-medium">{r.name}</span>
                        <span className="ml-1.5 font-mono text-[11px] text-[var(--color-jarvis-faint)]">{r.customerId}</span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">{r.orders}</td>
                      <td className="px-3 py-2.5 tabular-nums">{formatMinor(r.orderValueMinor, r.currency)}</td>
                      <td className="px-3 py-2.5 tabular-nums">{r.cases}</td>
                      <td className="px-3 py-2.5 tabular-nums">{r.pendingReview}</td>
                      <td className="px-3 py-2.5">{r.latest ? <StateBadge state={r.latest.state} /> : <span className="text-[var(--color-jarvis-faint)]">None</span>}</td>
                      <td className="px-3 py-2.5 text-right">
                        <button type="button" className={btn.ghost} onClick={() => onViewOrders(r.customerId)}>
                          View orders
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
