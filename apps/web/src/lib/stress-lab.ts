// Policy Stress Lab view logic: filtering, counts and plain-language reasons over STRESS_LAB_ROWS.
import { formatMinor } from "./money.ts";
import type { StressLabMoney, StressLabRow } from "./stress-lab-join.ts";
import { CHECK_LABELS, REASON_LABELS } from "./verdict.ts";

export interface StressLabFilter {
  category: string; // "ALL" or a category
  jarvis: string; // "ALL" or a final state
  unsafeOnly: boolean; // only cases unsafe without the policy layer
}

export const ALL = "ALL";

export function filterRows(rows: StressLabRow[], f: StressLabFilter): StressLabRow[] {
  return rows.filter(
    (r) => (f.category === ALL || r.category === f.category) && (f.jarvis === ALL || r.jarvis.finalState === f.jarvis) && (!f.unsafeOnly || r.noPolicy.unsafe),
  );
}

export function summarize(rows: StressLabRow[]) {
  const unsafeMoney = (r: StressLabRow) => r.noPolicy.unsafe && r.noPolicy.moneyMoved.length > 0;
  return {
    total: rows.length,
    jarvisExact: rows.filter((r) => r.jarvis.finalState === r.expected.finalState).length,
    jarvisMoneyMoves: rows.filter((r) => r.jarvis.moneyMoved.length > 0).length,
    noPolicyUnsafe: rows.filter((r) => r.noPolicy.unsafe).length,
    noPolicyUnauthorizedRefunds: rows.filter(unsafeMoney).length,
  };
}

export const unique = (values: string[]) => [...new Set(values)].sort();

export const money = (m: StressLabMoney[], currency: string) =>
  m.length === 0 ? `${formatMinor(0, currency)}, nothing executed` : m.map((x) => `${formatMinor(x.amountMinor, currency)} to ${x.transactionId}`).join(" + ");

/** One line per recorded stop reason, in the console's own vocabulary. */
export function reasonLines(reasons: string[]): string[] {
  return reasons.map((code) => {
    const [kind, rule] = code.split(":");
    if (kind === "POLICY_DENIED" && rule) return `Policy denied: ${CHECK_LABELS[rule] ?? rule}`;
    if (kind === "STALE_EVIDENCE" && rule) return `${REASON_LABELS.STALE_EVIDENCE}: ${CHECK_LABELS[rule] ?? rule}`;
    if (code === "MODEL_OUTPUT_INVALID") return "Model output failed schema validation, so nothing could be proposed";
    if (code === "EXECUTION_NOT_VERIFIED") return "Refund call did not verify on read-back, so the case failed closed";
    return REASON_LABELS[code] ?? code;
  });
}

/** Why JARVIS ended where it did, using only the recorded state, money and reasons. */
export function explainJarvis(r: StressLabRow): string {
  const s = r.jarvis.finalState;
  if (s === "RESOLVED") return "Every policy check passed. The amount came from the payment records, the simulated refund executed once and read-back verified it.";
  if (s === "CLOSED_NO_ACTION") return "The records show nothing left to refund, so policy authorized no action and the case closed without moving money.";
  if (s === "ESCALATED") return "Policy withheld execution and routed the case to a person with the evidence attached.";
  if (s === "FAILED") return "The case stopped before any verified money movement and failed closed for a person to review.";
  return s;
}

/** The case the detail panel shows: the chosen one if it survives the filter, otherwise the first visible case, otherwise none. */
export function pickSelected(rows: StressLabRow[], selectedId: string): StressLabRow | null {
  return rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
}
