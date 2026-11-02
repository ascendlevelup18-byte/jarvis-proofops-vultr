// Deterministic SAMPLE analytics data, for presenting the analytics workspace at a realistic
// scale. It is never mixed with recorded cases: the UI shows one dataset at a time and labels
// this one "Sample data" everywhere. Values are stable (fixed seed, fixed period ending
// SAMPLE_PERIOD_END) and claim nothing: no merchant, no revenue, no measured latency, and
// stationary outcome rates (no invented improvement trend).
import type { AnalyticsRecord, Outcome, RefundOutcome } from "./analytics.ts";

export const SAMPLE_PERIOD_END = Date.UTC(2026, 9, 12, 18, 0, 0); // 2026-10-12 18:00 UTC
export const SAMPLE_DAYS = 90;
const SEED = 20261012;

// Duplicate-charge amounts in minor units, mirroring the kind of orders in the demo store.
const AMOUNTS = [8999, 18000, 4500, 6450, 12900, 3999, 2450, 15900];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, weighted: [T, number][]): T {
  let x = rand();
  for (const [v, w] of weighted) {
    if ((x -= w) < 0) return v;
  }
  return weighted[weighted.length - 1][0];
}

let cache: AnalyticsRecord[] | null = null;

export function sampleRecords(): AnalyticsRecord[] {
  if (cache) return cache;
  const rand = mulberry32(SEED);
  const out: AnalyticsRecord[] = [];
  let seq = 1;
  for (let day = SAMPLE_DAYS - 1; day >= 0; day--) {
    const dayStart = SAMPLE_PERIOD_END - (day + 1) * 86_400_000;
    const n = 1 + Math.floor(rand() * 4); // 1–4 cases a day
    for (let i = 0; i < n; i++) {
      const at = dayStart + Math.floor(rand() * 86_400_000);
      const outcome = pick<Outcome>(rand, [
        ["resolved", 0.46],
        ["escalated", 0.3],
        ["closed", 0.19],
        ["failed", 0.05],
      ]);
      let refund: RefundOutcome;
      if (outcome === "resolved") refund = "verified";
      else if (outcome === "closed") refund = "not-needed";
      else if (outcome === "escalated") refund = rand() < 0.6 ? "blocked" : "none";
      else refund = rand() < 0.5 ? "not-confirmed" : "none";
      const id = `SAMPLE-${String(seq).padStart(4, "0")}`;
      out.push({
        id,
        orderId: `S${10000 + seq}`,
        customerId: `SAMPLE-CUST-${String(1 + Math.floor(rand() * 60)).padStart(3, "0")}`,
        at: new Date(Math.min(at, SAMPLE_PERIOD_END)).toISOString(),
        outcome,
        source: "sample",
        workflow: "Duplicate-charge refund",
        refund,
        refundMinor: refund === "verified" ? AMOUNTS[Math.floor(rand() * AMOUNTS.length)] : 0,
        currency: "USD",
        needsReview: outcome === "escalated" || outcome === "failed",
        aiCalls:
          outcome === "failed" && refund === "none"
            ? [{ stage: "Understanding", adapter: "sample", latencyMs: null, error: true }]
            : [
                { stage: "Understanding", adapter: "sample", latencyMs: null, error: false },
                { stage: "Decision", adapter: "sample", latencyMs: null, error: false },
              ],
      });
      seq += 1;
    }
  }
  cache = out;
  return out;
}
