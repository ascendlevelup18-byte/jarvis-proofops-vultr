// Client for the read-only demo store (GET /api/demo-store) and the customer-facing view of
// a case outcome. Customer copy is derived from the recorded case: a refund is only ever
// described as issued when the case is RESOLVED with a verified read-back.
import type { Case, CaseRequest } from "./case-types.ts";
import { formatMinor } from "./money.ts";

export interface DemoStoreOrder {
  orderId: string;
  customerId: string;
  customerName: string;
  totalMinor: number;
  currency: string;
  placedAt: string;
  charges: { id: string; amountMinor: number; currency: string; status: string; refundedMinor: number; at: string }[];
  supportRequest: { scenario: string; message: string };
}

export interface DemoStoreSnapshot {
  store: { name: string; data: "synthetic"; payments: "simulated" };
  orders: DemoStoreOrder[];
}

export async function fetchDemoStore(): Promise<DemoStoreSnapshot> {
  const res = await fetch("/api/demo-store");
  if (!res.ok) throw new Error(`Demo store unavailable (HTTP ${res.status})`);
  const body = (await res.json()) as DemoStoreSnapshot;
  if (!Array.isArray(body.orders)) throw new Error("Demo store returned an unexpected response");
  return body;
}

/** Accepts "48291", "#48291" or " order 48291 ". */
export function findOrder(snapshot: DemoStoreSnapshot, query: string): DemoStoreOrder | null {
  const id = query.replace(/order/i, "").replace(/[#\s]/g, "");
  return snapshot.orders.find((o) => o.orderId === id) ?? null;
}

/** The exact request the demo customer sends (allowlisted by the backend's public guard). */
export const refundRequestFor = (o: DemoStoreOrder): CaseRequest => ({
  customerId: o.customerId,
  orderId: o.orderId,
  message: o.supportRequest.message,
});

export interface CustomerReply {
  tone: "success" | "info" | "review" | "problem";
  title: string;
  body: string;
}

export function customerReply(c: Case): CustomerReply {
  if (c.state === "RESOLVED" && c.verification?.verified && c.verification.observedRefund) {
    const r = c.verification.observedRefund;
    return {
      tone: "success",
      title: `Refund of ${formatMinor(r.amountMinor, r.currency)} issued`,
      body: `We found the duplicate charge on order #${c.request.orderId} and refunded it. The refund was confirmed (reference ${r.id}). This is a demo: the payment is simulated.`,
    };
  }
  if (c.state === "CLOSED_NO_ACTION") {
    return {
      tone: "info",
      title: "No duplicate charge to refund",
      body: `Our records show order #${c.request.orderId} is already paid exactly once — an earlier refund covered the extra charge. Nothing further is needed.`,
    };
  }
  if (c.state === "ESCALATED") {
    return {
      tone: "review",
      title: "Passed to our team for review",
      body: "We couldn't approve this automatically, so a team member will review it. No refund has been made yet.",
    };
  }
  if (c.state === "FAILED") {
    return {
      tone: "problem",
      title: "We couldn't complete this automatically",
      body: "Something went wrong while processing your request. A team member will follow up. No refund has been confirmed.",
    };
  }
  return { tone: "info", title: "Request received", body: "Your request is being processed." };
}

export const orderPaidMinor = (o: DemoStoreOrder) =>
  o.charges.filter((c) => c.status === "SUCCEEDED").reduce((sum, c) => sum + c.amountMinor - c.refundedMinor, 0);

export const describeOrderBalance = (o: DemoStoreOrder) =>
  `${o.charges.length} charge${o.charges.length === 1 ? "" : "s"} · net paid ${formatMinor(orderPaidMinor(o), o.currency)} for a ${formatMinor(o.totalMinor, o.currency)} order`;
