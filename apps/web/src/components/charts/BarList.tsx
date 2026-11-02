import { ChartEmpty } from "./ChartCard.tsx";

export interface BarRow {
  key: string;
  label: string;
  value: number;
  /** Optional right-aligned annotation (e.g. "avg 12 ms"). */
  note?: string;
  onSelect?: () => void;
}

/** Horizontal ranked bars for categorical breakdowns; zero-based, one hue, value always printed. */
export function BarList({ rows, color = "var(--color-chart-series)", emptyText }: { rows: BarRow[]; color?: string; emptyText: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (max === 0) return <ChartEmpty>{emptyText}</ChartEmpty>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const body = (
          <>
            <span className="flex justify-between gap-2 text-xs">
              <span className="truncate text-[var(--color-jarvis-ink)]">{r.label}</span>
              <span className="shrink-0 tabular-nums text-[var(--color-jarvis-muted)]">
                <strong className="text-[var(--color-jarvis-ink)]">{r.value}</strong>
                {r.note ? ` · ${r.note}` : ""}
              </span>
            </span>
            <span aria-hidden className="mt-1 block h-1.5 rounded-full bg-[var(--color-chart-grid)]">
              <span className="block h-1.5 rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
            </span>
          </>
        );
        return (
          <li key={r.key}>
            {r.onSelect && r.value > 0 ? (
              <button type="button" onClick={r.onSelect} className="block w-full rounded px-1 py-0.5 text-left hover:bg-[var(--color-jarvis-surface-2)]">
                {body}
              </button>
            ) : (
              <div className="px-1 py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
