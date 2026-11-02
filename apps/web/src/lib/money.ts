const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
};

export function formatMinor(minor: number, currency: string): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const sym = CURRENCY_SYMBOL[currency] ?? "";
  if (sym) return `${sign}${sym}${major}.${frac}`;
  return `${sign}${major}.${frac} ${currency}`;
}
