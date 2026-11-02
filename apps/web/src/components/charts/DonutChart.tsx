import { useState } from "react";
import { ChartEmpty } from "./ChartCard.tsx";

export interface DonutSegment<K extends string> {
  key: K;
  label: string;
  value: number;
  color: string;
}

/**
 * Part-to-whole donut with the total in the centre and a value list beside it. The list rows are
 * buttons (the accessible, clickable equivalent of each arc) and drive the same drill-down.
 */
export function DonutChart<K extends string>({
  segments,
  centerLabel,
  onSelect,
  emptyText,
}: {
  segments: DonutSegment<K>[];
  centerLabel: string;
  onSelect?: (key: K) => void;
  emptyText: string;
}) {
  const [hover, setHover] = useState<K | null>(null);
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const R = 52;
  const C = 2 * Math.PI * R;
  const visible = segments.filter((s) => s.value > 0);
  const gap = visible.length > 1 ? 2 : 0;
  const offsets = visible.map((_, i) => visible.slice(0, i).reduce((sum, x) => sum + (x.value / total) * C, 0));
  const shown = hover ? segments.find((s) => s.key === hover) : null;

  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 128 128" className="h-32 w-32 shrink-0" role="img" aria-label={`${centerLabel}: ${segments.map((s) => `${s.value} ${s.label}`).join(", ")}`}>
        <circle cx="64" cy="64" r={R} fill="none" stroke="var(--color-chart-grid)" strokeWidth="14" />
        {visible.map((s, i) => {
          const len = (s.value / total) * C;
          const dash = Math.max(len - gap, 0.5);
          const el = (
            <circle
              key={s.key}
              cx="64"
              cy="64"
              r={R}
              fill="none"
              stroke={s.color}
              strokeWidth={hover === s.key ? 16 : 14}
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={-offsets[i]}
              transform="rotate(-90 64 64)"
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(s.key)}
              style={{ cursor: onSelect ? "pointer" : "default" }}
            />
          );
          return el;
        })}
        <text x="64" y="62" textAnchor="middle" className="fill-[var(--color-jarvis-ink)] text-[20px] font-semibold tabular-nums">
          {shown ? shown.value : total}
        </text>
        <text x="64" y="78" textAnchor="middle" className="fill-[var(--color-jarvis-muted)] text-[9px]">
          {shown ? `${Math.round((shown.value / total) * 100)}%` : centerLabel}
        </text>
      </svg>
      <ul className="min-w-40 flex-1 space-y-0.5">
        {segments.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              disabled={!onSelect || s.value === 0}
              onClick={() => onSelect?.(s.key)}
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(s.key)}
              onBlur={() => setHover(null)}
              className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--color-jarvis-surface-2)] disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[var(--color-jarvis-muted)]">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
                <span className="truncate">{s.label}</span>
              </span>
              <span className="tabular-nums text-[var(--color-jarvis-ink)]">
                <strong>{s.value}</strong>
                <span className="ml-1 text-[var(--color-jarvis-faint)]">{Math.round((s.value / total) * 100)}%</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
