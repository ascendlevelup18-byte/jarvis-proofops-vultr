// Deterministic business metrics over the synthetic dataset. Every metric carries its formula and the
// record ids it was computed from, so specialists cite numbers instead of generating them.
import { MONTHS, type MonthRecord } from "./dataset.ts";

export type MetricKey =
  | "netRevenue"
  | "orders"
  | "conversionPct"
  | "grossMarginPct"
  | "refundRatePct"
  | "refundCostSharePct"
  | "defectReturnSharePct"
  | "lateShipmentPct"
  | "csatPct"
  | "firstResponseHours"
  | "ticketsPerAgent"
  | "cacUsd"
  | "repeatOrderSharePct"
  | "marketingSpendUsd"
  | "supportFte";

export interface Metric {
  key: MetricKey;
  label: string;
  unit: "usd" | "pct" | "count" | "hours";
  formula: string;
  first: number; // value in the first month
  last: number; // value in the last month
  change: number; // last − first (percentage points for pct)
  series: number[];
  evidence: string[]; // record ids
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const usd = (minor: number) => minor / 100;

const DEFS: { key: MetricKey; label: string; unit: Metric["unit"]; formula: string; of: (m: MonthRecord) => number }[] = [
  { key: "netRevenue", label: "Net revenue", unit: "usd", formula: "gross sales − refunds", of: (m) => usd(m.grossSalesMinor - m.refundsMinor) },
  { key: "orders", label: "Orders", unit: "count", formula: "orders", of: (m) => m.orders },
  { key: "conversionPct", label: "Conversion rate", unit: "pct", formula: "orders ÷ sessions", of: (m) => (100 * m.orders) / m.sessions },
  { key: "grossMarginPct", label: "Gross margin", unit: "pct", formula: "(gross sales − refunds − COGS) ÷ (gross sales − refunds)", of: (m) => (100 * (m.grossSalesMinor - m.refundsMinor - m.cogsMinor)) / (m.grossSalesMinor - m.refundsMinor) },
  { key: "refundRatePct", label: "Refund rate", unit: "pct", formula: "refunded orders ÷ orders", of: (m) => (100 * m.refunds) / m.orders },
  { key: "refundCostSharePct", label: "Refunds as share of gross sales", unit: "pct", formula: "refunds ÷ gross sales", of: (m) => (100 * m.refundsMinor) / m.grossSalesMinor },
  { key: "defectReturnSharePct", label: "Defect returns as share of refunds", unit: "pct", formula: "defect returns ÷ refunded orders", of: (m) => (100 * m.defectReturns) / m.refunds },
  { key: "lateShipmentPct", label: "Late shipments", unit: "pct", formula: "late shipments ÷ orders", of: (m) => (100 * m.lateShipments) / m.orders },
  { key: "csatPct", label: "Customer satisfaction (4–5 of 5)", unit: "pct", formula: "survey share rating 4–5", of: (m) => m.csatPct },
  { key: "firstResponseHours", label: "Median first response", unit: "hours", formula: "median hours to first support reply", of: (m) => m.firstResponseHours },
  { key: "ticketsPerAgent", label: "Tickets per support agent", unit: "count", formula: "support tickets ÷ support FTE", of: (m) => m.supportTickets / m.supportAgentsFte },
  { key: "cacUsd", label: "Marketing cost per new customer", unit: "usd", formula: "marketing spend ÷ new customers", of: (m) => usd(m.marketingSpendMinor) / m.newCustomers },
  { key: "repeatOrderSharePct", label: "Orders from returning customers", unit: "pct", formula: "repeat orders ÷ orders", of: (m) => (100 * m.repeatOrders) / m.orders },
  { key: "marketingSpendUsd", label: "Marketing spend", unit: "usd", formula: "marketing spend", of: (m) => usd(m.marketingSpendMinor) },
  { key: "supportFte", label: "Support headcount (FTE)", unit: "count", formula: "support agents, full-time equivalent", of: (m) => m.supportAgentsFte },
];

export function computeMetrics(months: MonthRecord[] = MONTHS): Record<MetricKey, Metric> {
  const out = {} as Record<MetricKey, Metric>;
  for (const d of DEFS) {
    const series = months.map((m) => round(d.of(m), 2));
    const first = series[0]!;
    const last = series[series.length - 1]!;
    out[d.key] = { key: d.key, label: d.label, unit: d.unit, formula: d.formula, first, last, change: round(last - first, 2), series, evidence: months.map((m) => m.id) };
  }
  return out;
}

/**
 * Margin bridge: how many margin points the refund increase alone explains, holding COGS share at the first month.
 * Deterministic; the statement "refunds explain X points" is only as good as the synthetic records.
 */
export function marginBridge(months: MonthRecord[] = MONTHS) {
  const a = months[0]!;
  const b = months[months.length - 1]!;
  const margin = (gross: number, refunds: number, cogs: number) => (100 * (gross - refunds - cogs)) / (gross - refunds);
  const actualFirst = margin(a.grossSalesMinor, a.refundsMinor, a.cogsMinor);
  const actualLast = margin(b.grossSalesMinor, b.refundsMinor, b.cogsMinor);
  // Last month's sales and COGS with the first month's refund share.
  const refundsAtFirstShare = (b.grossSalesMinor * a.refundsMinor) / a.grossSalesMinor;
  const lastWithFirstRefunds = margin(b.grossSalesMinor, refundsAtFirstShare, b.cogsMinor);
  return {
    firstPct: round(actualFirst, 2),
    lastPct: round(actualLast, 2),
    totalChangePts: round(actualLast - actualFirst, 2),
    fromRefundsPts: round(actualLast - lastWithFirstRefunds, 2),
    fromCostsPts: round(lastWithFirstRefunds - actualFirst, 2),
    excessRefundsUsd: round(usd(b.refundsMinor - refundsAtFirstShare), 0),
    evidence: [a.id, b.id],
  };
}

/** Monthly support hours needed versus available, at an assumed handling time (an assumption, stated). */
export function supportCapacity(minutesPerTicket = 24, productiveHoursPerFte = 130, months: MonthRecord[] = MONTHS) {
  const m = months[months.length - 1]!;
  const needed = (m.supportTickets * minutesPerTicket) / 60;
  const available = m.supportAgentsFte * productiveHoursPerFte;
  return { minutesPerTicket, productiveHoursPerFte, supportFte: m.supportAgentsFte, neededHours: round(needed, 0), availableHours: round(available, 0), utilizationPct: round((100 * needed) / available, 1), assumption: `${minutesPerTicket} min per ticket, ${productiveHoursPerFte} productive h per FTE per month`, evidence: [m.id] };
}

export function formatMetricValue(unit: Metric["unit"], v: number): string {
  if (unit === "usd") return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v < 100 ? 2 : 0 });
  if (unit === "pct") return `${v.toFixed(1)}%`;
  if (unit === "hours") return `${v.toFixed(1)} h`;
  return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 1 });
}
