// A hard spending ceiling for live inference, checked before every model call.
// Each call reserves its worst case first: every byte of the request counted as an input token, plus the enforced
// output-token limit, both at the configured prices. A call that could pass the ceiling is never sent. Reported usage
// replaces the reservation when the provider returns it. A failed or unanswered call keeps its full reservation, because
// it may still have been billed. The ledger is written to disk after every change, so a restart can't reset it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface BudgetConfig {
  ceilingUsd: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxOutputTokens: number;
  file: string;
}
export interface BudgetEntry { at: string; reservedUsd: number; chargedUsd: number; promptTokens: number | null; completionTokens: number | null; status: "reserved" | "settled" | "failed" }
interface Ledger { ceilingUsd: number; entries: BudgetEntry[] }

const TEMPLATE_TOKENS = 256; // chat template and role markers, generously

export class InferenceBudget {
  readonly cfg: BudgetConfig;
  #ledger: Ledger;
  constructor(cfg: BudgetConfig) {
    if (!(cfg.ceilingUsd > 0) || !(cfg.inputUsdPerMillion > 0) || !(cfg.outputUsdPerMillion > 0) || !(cfg.maxOutputTokens > 0)) throw new Error("budget needs a ceiling, both prices and an output limit");
    this.cfg = cfg;
    this.#ledger = existsSync(cfg.file) ? (JSON.parse(readFileSync(cfg.file, "utf8")) as Ledger) : { ceilingUsd: cfg.ceilingUsd, entries: [] };
    // An unfinished reservation from an earlier process counts in full.
    for (const e of this.#ledger.entries) if (e.status === "reserved") { e.status = "failed"; e.chargedUsd = e.reservedUsd; }
    this.#save();
  }
  #save() {
    const tmp = `${this.cfg.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#ledger, null, 2));
    renameSync(tmp, this.cfg.file);
  }
  /** Committed spend: settled calls at reported usage, everything else at its full reservation. */
  get committedUsd(): number { return this.#ledger.entries.reduce((s, e) => s + (e.status === "settled" ? e.chargedUsd : e.reservedUsd), 0); }
  get calls(): number { return this.#ledger.entries.length; }
  worstCaseUsd(requestBytes: number): number {
    return ((requestBytes + TEMPLATE_TOKENS) * this.cfg.inputUsdPerMillion + this.cfg.maxOutputTokens * this.cfg.outputUsdPerMillion) / 1e6;
  }
  /** Reserves a call, or refuses it if its worst case could pass the ceiling. */
  reserve(requestBytes: number): { ok: true; index: number; reservedUsd: number } | { ok: false; reason: string } {
    const worst = this.worstCaseUsd(requestBytes);
    if (this.committedUsd + worst > this.cfg.ceilingUsd) {
      return { ok: false, reason: `inference budget: this call could cost up to $${worst.toFixed(5)}, and $${this.committedUsd.toFixed(5)} of $${this.cfg.ceilingUsd} is committed` };
    }
    this.#ledger.entries.push({ at: new Date().toISOString(), reservedUsd: worst, chargedUsd: worst, promptTokens: null, completionTokens: null, status: "reserved" });
    this.#save();
    return { ok: true, index: this.#ledger.entries.length - 1, reservedUsd: worst };
  }
  settle(index: number, usage: { promptTokens?: number; completionTokens?: number } | null) {
    const e = this.#ledger.entries[index];
    if (!e) return;
    const p = usage?.promptTokens, c = usage?.completionTokens;
    if (typeof p === "number" && typeof c === "number" && p >= 0 && c >= 0) {
      e.promptTokens = p;
      e.completionTokens = c;
      // Never record less than the provider's own count implies, and never more than was reserved unless usage says so.
      e.chargedUsd = (p * this.cfg.inputUsdPerMillion + c * this.cfg.outputUsdPerMillion) / 1e6;
      e.status = "settled";
    } else {
      e.status = "failed";
      e.chargedUsd = e.reservedUsd;
    }
    this.#save();
  }
  snapshot() {
    return { ceilingUsd: this.cfg.ceilingUsd, committedUsd: Number(this.committedUsd.toFixed(6)), calls: this.calls,
      pricing: { inputUsdPerMillion: this.cfg.inputUsdPerMillion, outputUsdPerMillion: this.cfg.outputUsdPerMillion, maxOutputTokens: this.cfg.maxOutputTokens } };
  }
}
