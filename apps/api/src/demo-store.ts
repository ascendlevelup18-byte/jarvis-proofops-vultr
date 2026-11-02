// Read-only demo store: the seeded synthetic customers, orders, charges and refunds, as
// a storefront would see them. Each order's support request is exactly its public demo
// request, so a storefront submission passes the access guard unchanged and becomes a real
// case. Nothing here writes, executes or exposes policy or credentials.
import { freshWorld, PUBLIC_DEMOS, type DemoId } from "./ingress.ts";

export interface DemoStoreOrder {
  orderId: string;
  customerId: string;
  customerName: string;
  totalMinor: number;
  currency: string;
  placedAt: string;
  charges: { id: string; amountMinor: number; currency: string; status: string; refundedMinor: number; at: string }[];
  /** The canned support request the demo customer sends for this order. */
  supportRequest: { scenario: DemoId; message: string };
}

export interface DemoStoreSnapshot {
  store: { name: string; data: "synthetic"; payments: "simulated" };
  orders: DemoStoreOrder[];
}

export function demoStoreSnapshot(clock: () => Date): DemoStoreSnapshot {
  const { store } = freshWorld(clock);
  const orders = (Object.entries(PUBLIC_DEMOS) as [DemoId, (typeof PUBLIC_DEMOS)[DemoId]][]).map(([scenario, req]) => {
    const order = store.getOrder(req.orderId)!;
    const customer = store.getCustomer(order.customerId)!;
    return {
      orderId: order.id,
      customerId: customer.id,
      customerName: customer.name,
      totalMinor: order.totalMinor,
      currency: order.currency,
      placedAt: order.createdAt,
      charges: store.transactionsForOrder(order.id).map((t) => ({
        id: t.id,
        amountMinor: t.amountMinor,
        currency: t.currency,
        status: t.status,
        refundedMinor: t.refundedMinor,
        at: t.createdAt,
      })),
      supportRequest: { scenario, message: req.message },
    };
  });
  return { store: { name: "Northwind Goods (demo)", data: "synthetic", payments: "simulated" }, orders };
}
