import type { DemoStoreSnapshot } from "./demo-store.ts";
import type { Route } from "./routes.ts";
import type { SessionCaseEntry } from "./session-store.ts";

export interface SearchHit {
  key: string;
  kind: "Order" | "Customer" | "Case";
  label: string;
  detail: string;
  route: Route;
}

/** Searches only what the app holds: demo-store orders and customers, and recorded cases. */
export function searchRecords(q: string, store: DemoStoreSnapshot | null, history: SessionCaseEntry[]): SearchHit[] {
  const needle = q.trim().toLowerCase().replace(/^#/, "");
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const o of store?.orders ?? []) {
    if (o.orderId.includes(needle))
      hits.push({ key: `o-${o.orderId}`, kind: "Order", label: `#${o.orderId}`, detail: o.customerName, route: { surface: "merchant", nav: "orders", orderId: o.orderId } });
  }
  const seen = new Set<string>();
  for (const o of store?.orders ?? []) {
    if (seen.has(o.customerId)) continue;
    if (o.customerName.toLowerCase().includes(needle) || o.customerId.toLowerCase().includes(needle)) {
      seen.add(o.customerId);
      hits.push({ key: `c-${o.customerId}`, kind: "Customer", label: o.customerName, detail: o.customerId, route: { surface: "merchant", nav: "orders", params: { q: o.customerId } } });
    }
  }
  for (const h of history) {
    if (h.id.toLowerCase().includes(needle))
      hits.push({ key: `k-${h.id}`, kind: "Case", label: h.id.slice(0, 18), detail: `#${h.orderId} · ${h.state}`, route: { surface: "merchant", nav: "cases", caseId: h.id } });
  }
  return hits.slice(0, 8);
}

