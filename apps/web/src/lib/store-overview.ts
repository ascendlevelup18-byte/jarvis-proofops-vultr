import type { DemoStoreSnapshot } from './demo-store.ts';

export type OverviewMetric = 'sales' | 'orders' | 'sessions' | 'conversion';
export interface StoreDay { date: string; sales: number; orders: number; sessions: number | null }
const DAY = 86400000;
export const dayKey = (date: Date) => date.toISOString().slice(0, 10);
export const shiftDay = (date: string, offset: number) => dayKey(new Date(Date.parse(`${date}T12:00:00Z`) + offset * DAY));

/** Illustrative traffic and revenue, kept separate from the backend's order records. */
export function sampleStoreDays(end: string): StoreDay[] {
  // Three 28-day windows cover a previous-range selection and its comparison.
  const mod = (n: number, base: number) => ((n % base) + base) % base;
  return Array.from({ length: 84 }, (_, index) => {
    const i = index - 28;
    const sessions = 210 + mod(i * 37, 140) + Math.round(55 * Math.sin(i * .7));
    const orders = 5 + mod(i * 7, 9);
    return { date: shiftDay(end, i - 55), sessions, orders, sales: orders * (6800 + mod(i * 317, 4000)) };
  });
}

/** Order value before refunds, not net sales or duplicated card charges. */
export function demoOrderDays(snapshot: DemoStoreSnapshot | null, currency: string): StoreDay[] {
  const days = new Map<string, StoreDay>();
  for (const o of snapshot?.orders ?? []) {
    if (o.currency !== currency) continue;
    const date = o.placedAt.slice(0, 10);
    const row = days.get(date) ?? { date, sales: 0, orders: 0, sessions: null };
    row.sales += o.totalMinor;
    row.orders++;
    days.set(date, row);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function overviewWindow(days: StoreDay[], end: string, length: number, traffic: boolean) {
  const byDate = new Map(days.map(d => [d.date, d]));
  const series = (last: string) => Array.from({ length }, (_, i) => {
    const date = shiftDay(last, i - length + 1);
    return byDate.get(date) ?? { date, sales: 0, orders: 0, sessions: traffic ? 0 : null };
  });
  return { current: series(end), previous: series(shiftDay(end, -length)) };
}

export function totals(days: StoreDay[]) {
  const sales = days.reduce((n, d) => n + d.sales, 0);
  const orders = days.reduce((n, d) => n + d.orders, 0);
  const sessions = days.some(d => d.sessions === null) ? null : days.reduce((n, d) => n + (d.sessions ?? 0), 0);
  return { sales, orders, sessions, conversion: sessions ? orders / sessions * 100 : null };
}

export function comparison(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return 'No visit tracking';
  if (!previous) return current ? 'No earlier data' : 'No change';
  const change = (current - previous) / previous * 100;
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}% vs previous period`;
}

export function metricValue(day: StoreDay, metric: OverviewMetric): number {
  if (metric === 'conversion') return day.sessions ? day.orders / day.sessions * 100 : 0;
  return day[metric] ?? 0;
}
