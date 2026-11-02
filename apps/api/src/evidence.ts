// Deterministic evidence gathering. The structured request is used only as stated
// claims to check against records; it never substitutes for a record.
import {
  CURRENCIES,
  type CaseRequest,
  type DuplicateGroup,
  type EvidenceBundle,
  type FinancialState,
  type MoneyMention,
  type Order,
  type PaymentTransaction,
  type Reason,
  type RefundPolicy,
  type StructuredRequest,
} from "./contracts.ts";
import type { CommerceStore } from "./fixtures.ts";
import { findIntentCues } from "./intent-cues.ts";
import { findMoneyMentions, formatMinor } from "./money.ts";

export type GatherResult = { ok: true; evidence: EvidenceBundle } | { ok: false; reason: Reason };

export function normalizeOrderId(raw: string): string {
  return raw.trim().replace(/^#/, "");
}

// Explicit order references only: "order 123", "order no. 123", "order #123", "#123".
// The id must contain at least 3 digits, so "2 days", "order of 3", "$250" are not orders.
const ORDER_REF = /(?:\border\b\s*(?:no\.?|number|id)?\s*#?\s*|#)([A-Za-z0-9-]*\d{3,}[A-Za-z0-9-]*)/gi;

export function findOrderReferences(text: string): string[] {
  return [...new Set([...text.matchAll(ORDER_REF)].map((m) => normalizeOrderId(m[1]!)))];
}

// Successful charges with identical amount+currency, each within the window of
// the previous one, form a group of size >= 2.
export function findDuplicateGroups(txs: readonly PaymentTransaction[], windowMinutes: number): DuplicateGroup[] {
  const sorted = txs
    .filter((t) => t.status === "SUCCEEDED")
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const byKey = new Map<string, PaymentTransaction[]>();
  for (const t of sorted) byKey.set(`${t.currency}:${t.amountMinor}`, [...(byKey.get(`${t.currency}:${t.amountMinor}`) ?? []), t]);

  const groups: DuplicateGroup[] = [];
  for (const list of byKey.values()) {
    let run: PaymentTransaction[] = [];
    const flush = () => {
      if (run.length >= 2) {
        groups.push({ transactionIds: run.map((t) => t.id), amountMinor: run[0]!.amountMinor, currency: run[0]!.currency });
      }
    };
    for (const t of list) {
      const prev = run.at(-1);
      if (prev && Date.parse(t.createdAt) - Date.parse(prev.createdAt) > windowMinutes * 60_000) {
        flush();
        run = [];
      }
      run.push(t);
    }
    flush();
  }
  return groups;
}

// What the customer has actually paid for this order, net of refunds.
export function financialState(order: Order, txs: readonly PaymentTransaction[]): FinancialState {
  const netPaidMinor = txs
    .filter((t) => t.status === "SUCCEEDED" && t.currency === order.currency)
    .reduce((sum, t) => sum + t.amountMinor - t.refundedMinor, 0);
  const status =
    netPaidMinor === order.totalMinor ? "PAID_EXACTLY_ONCE" : netPaidMinor > order.totalMinor ? "OVERPAID" : "UNDERPAID";
  return { netPaidMinor, orderTotalMinor: order.totalMinor, status };
}

function dedupe(mentions: MoneyMention[]): MoneyMention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const k = `${m.amountMinor}:${m.currency}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export function gatherEvidence(
  req: CaseRequest,
  understanding: StructuredRequest,
  store: CommerceStore,
  policy: RefundPolicy,
): GatherResult {
  const customer = store.getCustomer(req.customerId);
  if (!customer) return { ok: false, reason: { code: "CUSTOMER_NOT_FOUND", detail: req.customerId } };
  const orderId = normalizeOrderId(req.orderId);
  const order = store.getOrder(orderId);
  if (!order) return { ok: false, reason: { code: "ORDER_NOT_FOUND", detail: orderId } };
  if (order.customerId !== customer.id) {
    return { ok: false, reason: { code: "ORDER_OWNERSHIP_MISMATCH", detail: `order ${orderId} is not owned by ${customer.id}` } };
  }

  const transactions = store.transactionsForOrder(order.id);
  const refunds = store.refundsForTransactions(transactions.map((t) => t.id));
  const duplicateGroups = findDuplicateGroups(transactions, policy.duplicateWindowMinutes);
  const financial = financialState(order, transactions);
  // Structured understanding plus a deterministic scan of the raw message as a backstop,
  // so an understanding adapter that omits an amount cannot hide a conflict.
  const mentionedAmounts = dedupe([...understanding.mentionedAmounts, ...findMoneyMentions(req.message)]);

  const contradictions: string[] = [];
  for (const t of transactions) {
    if (t.customerId !== customer.id) contradictions.push(`transaction ${t.id} belongs to another customer`);
    if (t.currency !== order.currency) contradictions.push(`transaction ${t.id} currency ${t.currency} != order ${order.currency}`);
    if (t.refundedMinor > t.amountMinor) {
      contradictions.push(`transaction ${t.id} refunded ${formatMinor(t.refundedMinor, t.currency)} exceeds its charge`);
    }
    // The transaction's refunded amount must be backed by exactly matching refund records.
    const ledgerMinor = refunds
      .filter((r) => r.transactionId === t.id && r.status === "SUCCEEDED")
      .reduce((sum, r) => sum + r.amountMinor, 0);
    if (ledgerMinor !== t.refundedMinor) {
      contradictions.push(
        `transaction ${t.id} shows ${formatMinor(t.refundedMinor, t.currency)} refunded but the refund ledger records ${formatMinor(ledgerMinor, t.currency)}`,
      );
    }
  }
  for (const ref of findOrderReferences(req.message)) {
    if (ref.toLowerCase() !== order.id.toLowerCase()) {
      contradictions.push(`customer references order ${ref} but this case is for order ${order.id}`);
    }
  }
  // Amounts a customer could legitimately quote: one charge, the order total, or a duplicate group's total.
  const plausible = new Set<number>([order.totalMinor]);
  for (const t of transactions) if (t.status === "SUCCEEDED") plausible.add(t.amountMinor);
  for (const g of duplicateGroups) plausible.add(g.amountMinor * g.transactionIds.length);
  for (const m of mentionedAmounts) {
    if (m.currency === null) {
      contradictions.push(`customer states amount "${m.text}" without a currency`);
    } else if (!(CURRENCIES as readonly string[]).includes(m.currency)) {
      contradictions.push(`customer states amount "${m.text}" in unsupported currency ${m.currency}`);
    } else if (m.currency !== order.currency) {
      contradictions.push(`customer states amount "${m.text}" in ${m.currency} but order currency is ${order.currency}`);
    } else if (!plausible.has(m.amountMinor)) {
      contradictions.push(
        `customer states ${formatMinor(m.amountMinor, m.currency)}, which matches no verified charge or order total`,
      );
    }
  }

  const sourceIds = [
    order.id,
    ...transactions.map((t) => t.id),
    ...refunds.map((r) => r.id),
    policy.id,
    ...policy.sections.map((s) => s.id),
  ];

  return {
    ok: true,
    evidence: {
      customer,
      order,
      transactions,
      refunds,
      policy,
      customerIntent: understanding.intent,
      intentCues: findIntentCues(req.message),
      duplicateGroups,
      financial,
      mentionedAmounts,
      contradictions,
      sourceIds,
    },
  };
}
