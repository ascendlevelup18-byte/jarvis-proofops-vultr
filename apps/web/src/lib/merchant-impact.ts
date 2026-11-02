// Merchant Impact Studio: the value model from docs/improvement/BUSINESS_CASE.md §3–4, made editable.
// Every input is an assumption. Nothing here is observed merchant data, savings or ROI.

export interface ImpactAssumptions {
  casesPerMonth: number; // duplicate-charge tickets per month
  autoResolvedPct: number; // A: share JARVIS closes with no human, 0–100
  minutesPerCase: number; // T: agent minutes per case today
  loadedCostPerHour: number; // C: loaded agent cost per hour, USD
  feePerResolved: number; // pricing hypothesis, USD per resolved case
  feePerEscalation: number; // pricing hypothesis, USD per escalation with evidence pack
  monthlyMinimum: number; // pricing hypothesis, USD
  modelCostPerCase: number; // USD; not measured for JARVIS, enter your provider's price
}

/** Defaults are the business case's own example values. */
export const DEFAULT_ASSUMPTIONS: ImpactAssumptions = {
  casesPerMonth: 400,
  autoResolvedPct: 30,
  minutesPerCase: 8,
  loadedCostPerHour: 35,
  feePerResolved: 0.5,
  feePerEscalation: 0.1,
  monthlyMinimum: 99,
  modelCostPerCase: 0,
};

export const BUSINESS_CASE_FILE = "docs/improvement/BUSINESS_CASE.md";

/** Accepted range per input; computeImpact clamps to these and the studio says when it did. */
export const LIMITS: Record<keyof ImpactAssumptions, [number, number]> = {
  casesPerMonth: [0, 10_000_000],
  autoResolvedPct: [0, 100],
  minutesPerCase: [0, 24 * 60],
  loadedCostPerHour: [0, 10_000],
  feePerResolved: [0, 1_000],
  feePerEscalation: [0, 1_000],
  monthlyMinimum: [0, 1_000_000],
  modelCostPerCase: [0, 1_000],
};

/** Null when the value is used as entered; otherwise the value actually used. */
export function clampNote(key: keyof ImpactAssumptions, value: number): string | null {
  const [lo, hi] = LIMITS[key];
  if (!Number.isFinite(value)) return `Not a number; using ${lo}.`;
  if (value < lo) return `Below ${lo}; using ${lo}.`;
  if (value > hi) return `Above ${hi.toLocaleString("en-US")}; using ${hi.toLocaleString("en-US")}.`;
  return null;
}

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

export function computeImpact(a: ImpactAssumptions) {
  const cases = clamp(a.casesPerMonth, 0, 10_000_000);
  const share = clamp(a.autoResolvedPct, 0, 100) / 100;
  const minutes = clamp(a.minutesPerCase, 0, 24 * 60);
  const autoResolved = cases * share;
  const escalated = cases - autoResolved;
  const hoursSaved = (autoResolved * minutes) / 60; // = cases × A × T / 60
  const laborValue = hoursSaved * clamp(a.loadedCostPerHour, 0, 10_000);
  const usageFees = autoResolved * clamp(a.feePerResolved, 0, 1_000) + escalated * clamp(a.feePerEscalation, 0, 1_000);
  const jarvisFee = Math.max(usageFees, clamp(a.monthlyMinimum, 0, 1_000_000));
  const modelCost = cases * clamp(a.modelCostPerCase, 0, 1_000);
  const processingCost = jarvisFee + modelCost;
  return { autoResolved, escalated, hoursSaved, laborValue, usageFees, jarvisFee, minimumApplies: usageFees < jarvisFee, modelCost, processingCost, netHypothesis: laborValue - processingCost };
}

export const PILOT_STEPS = [
  { when: "Week 1", what: "Shadow mode: JARVIS reads tickets and payment records with read-only keys, proposes and logs what it would do. No refunds." },
  { when: "Week 2", what: "Compare agents' real decisions with JARVIS proposals and policy outcomes." },
  { when: "Weeks 3–4", what: "Assisted: refunds below a low limit through the provider's sandbox first, then production with per-refund human confirmation; read-back on every refund." },
  { when: "Exit", what: "Go or no-go on autonomous execution under the merchant's own limits, only if the pilot recorded no unsafe actions." },
] as const;

export const PILOT_MEASURES = [
  "Agent minutes per duplicate-charge case today (T)",
  "Share JARVIS could close with no human on real traffic (A)",
  "Disagreements between agents and JARVIS, and their causes",
  "Would-be unsafe actions (target: 0)",
  "Read-back accuracy against the payment provider",
  "Model cost per case on the merchant's chosen provider",
] as const;

/** The value the calculation actually uses for an input (after clamping to LIMITS). */
export const usedValue = (key: keyof ImpactAssumptions, value: number) => clamp(value, LIMITS[key][0], LIMITS[key][1]);
