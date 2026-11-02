// Money is integer minor units. No floating point arithmetic on amounts.
import type { Currency, MoneyMention } from "./contracts.ts";

const SYMBOL: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };
// Codes we recognise as *currencies* (supported or not), so "CAD 89.99" is seen as a
// foreign amount while ordinary 3-letter words ("for", "you") are not.
const KNOWN_CODES = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "JPY", "CHF", "CNY", "INR", "MXN", "BRL", "SEK", "NOK", "DKK"]);
const AMOUNT_RE = /([$€£])?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/g;
const REFERENCE_BEFORE = /(#|\border\s*(?:no\.?|number)?\s*#?)\s*$/i;

function codeNear(before: string, after: string): string | null {
  const b = /\b([A-Za-z]{3})\s?$/.exec(before)?.[1]?.toUpperCase();
  if (b && KNOWN_CODES.has(b)) return b;
  const a = /^\s?([A-Za-z]{3})\b/.exec(after)?.[1]?.toUpperCase();
  return a && KNOWN_CODES.has(a) ? a : null;
}

// Every amount the customer states, including bare numbers ("refund 250") and
// unsupported currencies ("CAD 89.99"). Order references ("#48291", "order 50102")
// are not amounts. Over-detection is safe: an unexplained amount blocks autonomy.
export function findMoneyMentions(text: string): MoneyMention[] {
  const out: MoneyMention[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [raw, symbol, whole, frac] = m;
    const start = m.index;
    const before = text.slice(Math.max(0, start - 16), start);
    const after = text.slice(start + raw.length, start + raw.length + 5);
    const code = codeNear(before, after);
    if (!symbol && !code && (REFERENCE_BEFORE.test(before) || (!frac && whole!.replaceAll(",", "").length >= 5))) continue;
    const minor = Number(whole!.replaceAll(",", "")) * 100 + Number((frac ?? "").padEnd(2, "0"));
    if (!Number.isSafeInteger(minor)) continue;
    out.push({ text: raw.trim(), amountMinor: minor, currency: symbol ? SYMBOL[symbol]! : code });
  }
  return out;
}

export function formatMinor(minor: number, currency: Currency | string): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}
