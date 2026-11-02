// SYNTHETIC merchant dataset for the AI Team prototype. Invented for demonstration; not any real company's data.
// Six monthly records for one fictional online store. Every number the AI Team cites comes from here
// through the deterministic functions in metrics.ts; no model is asked to produce figures.

export interface MonthRecord {
  id: string; // citation id, e.g. "M-2026-04"
  month: string; // YYYY-MM
  sessions: number; // storefront visits
  orders: number;
  grossSalesMinor: number; // before refunds, USD cents
  cogsMinor: number; // cost of goods sold, USD cents
  refunds: number; // refunded orders
  refundsMinor: number; // refunded amount, USD cents
  supportTickets: number;
  supportAgentsFte: number;
  firstResponseHours: number; // median
  csatPct: number; // share of surveyed customers rating 4–5 of 5
  marketingSpendMinor: number;
  newCustomers: number;
  repeatOrders: number; // orders from returning customers
  lateShipments: number;
  defectReturns: number; // refunds caused by a damaged or defective item
}

export const DATASET_META = {
  id: "northwind-synthetic-v1",
  label: "Synthetic data · fictional store · not real merchant records",
  company: "Northwind Goods (synthetic)",
  currency: "USD",
} as const;

export const MONTHS: MonthRecord[] = [
  { id: "M-2026-04", month: "2026-04", sessions: 152000, orders: 4560, grossSalesMinor: 31_920_000, cogsMinor: 17_556_000, refunds: 137, refundsMinor: 958_000, supportTickets: 1290, supportAgentsFte: 6, firstResponseHours: 4.1, csatPct: 88, marketingSpendMinor: 3_600_000, newCustomers: 1900, repeatOrders: 2280, lateShipments: 182, defectReturns: 41 },
  { id: "M-2026-05", month: "2026-05", sessions: 158000, orders: 4580, grossSalesMinor: 32_060_000, cogsMinor: 17_633_000, refunds: 160, refundsMinor: 1_120_000, supportTickets: 1385, supportAgentsFte: 6, firstResponseHours: 4.9, csatPct: 86, marketingSpendMinor: 3_900_000, newCustomers: 1940, repeatOrders: 2240, lateShipments: 229, defectReturns: 52 },
  { id: "M-2026-06", month: "2026-06", sessions: 165000, orders: 4455, grossSalesMinor: 31_185_000, cogsMinor: 17_464_000, refunds: 196, refundsMinor: 1_372_000, supportTickets: 1520, supportAgentsFte: 6, firstResponseHours: 6.3, csatPct: 83, marketingSpendMinor: 4_300_000, newCustomers: 1960, repeatOrders: 2090, lateShipments: 312, defectReturns: 71 },
  { id: "M-2026-07", month: "2026-07", sessions: 171000, orders: 4275, grossSalesMinor: 29_925_000, cogsMinor: 16_908_000, refunds: 231, refundsMinor: 1_617_000, supportTickets: 1660, supportAgentsFte: 6, firstResponseHours: 7.8, csatPct: 80, marketingSpendMinor: 4_700_000, newCustomers: 1910, repeatOrders: 1920, lateShipments: 385, defectReturns: 88 },
  { id: "M-2026-08", month: "2026-08", sessions: 176000, orders: 4048, grossSalesMinor: 28_336_000, cogsMinor: 16_151_000, refunds: 259, refundsMinor: 1_813_000, supportTickets: 1790, supportAgentsFte: 5.5, firstResponseHours: 9.6, csatPct: 77, marketingSpendMinor: 5_100_000, newCustomers: 1850, repeatOrders: 1740, lateShipments: 437, defectReturns: 104 },
  { id: "M-2026-09", month: "2026-09", sessions: 180000, orders: 3870, grossSalesMinor: 27_090_000, cogsMinor: 15_713_000, refunds: 282, refundsMinor: 1_974_000, supportTickets: 1910, supportAgentsFte: 5.5, firstResponseHours: 11.2, csatPct: 74, marketingSpendMinor: 5_400_000, newCustomers: 1780, repeatOrders: 1590, lateShipments: 480, defectReturns: 118 },
];
