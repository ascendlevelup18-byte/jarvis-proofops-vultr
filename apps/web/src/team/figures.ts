// Figure check: a specialist may only state numbers that the deterministic calculations can produce.
// Applied to every finding, recommendation and private reply before it is shown, whichever provider wrote it.
// Unsupported figures are never shown: the statement that carries one is withheld and the withholding is audited.
import type { ScopedContext } from "./context.ts";

// Plain, grouped, decimal, leading-dot and scientific forms, with an optional unit or magnitude word.
const NUM = /-?\$?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?\s*(?:%|percent\b|per cent\b|pts?\b|points?\b|h\b|k\b|m\b|bn\b|thousand\b|million\b|billion\b)?/gi;
const WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)";
const NUMBER_WORDS = new RegExp(`\\b${WORD}(?:[\\s-]+(?:and\\s+|point\\s+)?${WORD})*\\s+(?:percent|per cent|dollars|points|percentage points)\\b`, "gi");
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

interface Figure {
  raw: string;
  value: number;
  unit: boolean; // carries %, $, points or a magnitude: never exempt as a "small count"
  step: number; // half of the last stated digit, so honest rounding ("$1.2M") is accepted
}

function parse(raw: string): Figure | null {
  const t = raw.toLowerCase().replace(/\s+/g, " ").trim();
  const m = /^(-?)(\$?)([\d,]*\.?\d+(?:e[+-]?\d+)?)\s*(.*)$/.exec(t);
  if (!m) return null;
  const digits = m[3]!.replace(/,/g, "");
  let value = Number(digits);
  if (!Number.isFinite(value)) return null;
  const suffix = m[4]!.trim();
  const mult = MULT[suffix] ?? 1;
  const decimals = /e/.test(digits) ? 0 : (digits.split(".")[1] ?? "").length;
  value *= mult * (m[1] ? -1 : 1);
  const unit = Boolean(m[2]) || (suffix !== "" && suffix !== "h");
  return { raw: raw.trim(), value, unit, step: mult === 1 ? 0 : (0.5 * mult) / 10 ** decimals };
}

/** Every number the scoped context can justify. */
export function allowedFigures(ctx: ScopedContext): number[] {
  const out: number[] = [];
  for (const m of Object.values(ctx.metrics)) {
    if (!m) continue;
    out.push(m.first, m.last, m.change, Math.abs(m.change), ...m.series);
  }
  for (const t of Object.values(ctx.tools)) {
    if (!t) continue;
    for (const v of Object.values(t)) if (typeof v === "number") out.push(v, Math.abs(v));
  }
  return out;
}

const close = (f: Figure, b: number) => Math.abs(Math.abs(f.value) - Math.abs(b)) <= Math.max(0.051, Math.abs(b) * 0.005, f.step);

/**
 * Numbers in the text that no calculation supports. Plain small counts (≤ 12, no unit), years and record ids are
 * allowed. Non-ASCII digits and spelled-out amounts ("sixty percent") cannot be verified and are always reported.
 */
export function unsupportedFigures(text: string, ctx: ScopedContext, extra: number[] = []): string[] {
  const allowed = [...allowedFigures(ctx), ...extra];
  const bad: string[] = [];
  const norm = text.normalize("NFKC"); // full-width digits become ASCII and are checked like any other
  for (const d of norm.match(/[^\P{Nd}0-9]+/gu) ?? []) bad.push(d); // digits of other scripts: unverifiable
  for (const w of norm.match(NUMBER_WORDS) ?? []) bad.push(w.trim());
  const cleaned = norm.replace(/\bM-\d{4}-\d{2}\b/g, " ").replace(/\b20\d\d(-\d\d)?\b(?!\s*%|\.\d)/g, " ");
  for (const raw of cleaned.match(NUM) ?? []) {
    const f = parse(raw);
    if (!f) continue;
    if (!f.unit && Number.isInteger(f.value) && Math.abs(f.value) <= 12) continue;
    if (f.value === 0 || f.value === 100) continue; // exact bounds ("below 100% utilization") are not data claims
    if (!allowed.some((a) => close(f, a))) bad.push(f.raw);
  }
  return bad;
}

/**
 * Removes every sentence that states an unsupported figure. The withheld figures are not repeated in the
 * returned text (they go to the audit only), so an unverified number never reaches the screen.
 */
export function withholdUnsupported(text: string, ctx: ScopedContext): { text: string; withheld: number; figures: string[] } {
  const parts = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim() !== "");
  const kept: string[] = [];
  const figures: string[] = [];
  for (const s of parts) {
    const bad = unsupportedFigures(s, ctx);
    if (bad.length) figures.push(...bad);
    else kept.push(s.trim());
  }
  const withheld = parts.length - kept.length;
  if (withheld === 0) return { text, withheld, figures };
  const note = `[JARVIS check: ${withheld} statement${withheld === 1 ? "" : "s"} withheld because ${withheld === 1 ? "it used a figure" : "they used figures"} not in the data.]`;
  return { text: kept.length ? `${kept.join(" ")}\n\n${note}` : note, withheld, figures };
}
