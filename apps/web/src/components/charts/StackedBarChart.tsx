import { useState } from "react";
import { ChartEmpty } from "./ChartCard.tsx";
import { niceMax, ticks } from "./scale.ts";

export interface StackSeries<K extends string> {
  key: K;
  label: string;
  color: string;
}

export interface StackColumn<K extends string> {
  id: string;
  label: string;
  /** Longer label for the tooltip (e.g. full date range). */
  title: string;
  values: Record<K, number>;
}

/**
 * Stacked columns over time with a zero-based y axis, sparse x labels, one tooltip per column listing
 * every series, keyboard focus per column, and click-through on a segment (drill-down).
 */
export function StackedBarChart<K extends string>({
  series,
  columns,
  height = 200,
  onSelect,
  emptyText,
}: {
  series: StackSeries<K>[];
  columns: StackColumn<K>[];
  height?: number;
  onSelect?: (key: K, column: StackColumn<K>) => void;
  emptyText: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = columns.map((c) => series.reduce((s, x) => s + (c.values[x.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  if (totals.every((t) => t === 0)) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const labelEvery = Math.max(1, Math.ceil(columns.length / 8));
  const yTicks = ticks(max, max <= 5 ? max : 5).filter((t) => Number.isInteger(t));
  const h = hover === null ? null : columns[hover];

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="relative w-6 shrink-0 text-right text-[10px] tabular-nums text-[var(--color-jarvis-faint)]" style={{ height }} aria-hidden>
          {yTicks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - t / max) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            {yTicks.map((t) => (
              <div key={t} className="absolute inset-x-0 border-t border-[var(--color-chart-grid)]" style={{ top: `${(1 - t / max) * 100}%` }} />
            ))}
          </div>
          <div className="relative flex items-end gap-[2px] border-b border-[var(--color-jarvis-border-strong)]" style={{ height }} onMouseLeave={() => setHover(null)}>
            {columns.map((c, i) => (
              <div
                key={c.id}
                tabIndex={0}
                role="group"
                aria-label={`${c.title}: ${totals[i]} total — ${series.map((s) => `${c.values[s.key] ?? 0} ${s.label}`).join(", ")}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className={`flex h-full min-w-0 flex-1 flex-col-reverse gap-[2px] rounded-t-sm outline-none ${hover === i ? "bg-[var(--color-jarvis-surface-2)]" : ""} focus-visible:ring-2 focus-visible:ring-[var(--color-deterministic-accent)]`}
              >
                {series.map((s) => {
                  const v = c.values[s.key] ?? 0;
                  if (!v) return null;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      tabIndex={-1}
                      aria-label={`${v} ${s.label}, ${c.title}`}
                      onClick={() => onSelect?.(s.key, c)}
                      className="w-full shrink-0 first:rounded-b-none last:rounded-t-[3px] hover:brightness-110"
                      style={{ height: `${(v / max) * 100}%`, background: s.color, cursor: onSelect ? "pointer" : "default" }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-[2px] text-[10px] tabular-nums text-[var(--color-jarvis-faint)]" aria-hidden>
            {columns.map((c, i) => (
              <span key={c.id} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
                {i % labelEvery === 0 ? c.label : ""}
              </span>
            ))}
          </div>
          {h && (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-0 z-10 w-48 rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] p-2 text-xs shadow-raised"
              style={{
                left: `${((hover! + 0.5) / columns.length) * 100}%`,
                transform: hover! / columns.length > 0.6 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
              }}
            >
              <p className="mb-1 text-[11px] text-[var(--color-jarvis-muted)]">{h.title}</p>
              {series.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[var(--color-jarvis-muted)]">
                    <span aria-hidden className="h-0.5 w-3" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <strong className="tabular-nums text-[var(--color-jarvis-ink)]">{h.values[s.key] ?? 0}</strong>
                </p>
              ))}
              <p className="mt-1 flex justify-between border-t border-[var(--color-jarvis-border)] pt-1 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{totals[hover!]}</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
