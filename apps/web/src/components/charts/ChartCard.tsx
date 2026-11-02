import { useState, type ReactNode } from "react";

export interface LegendItem {
  key: string;
  label: string;
  color: string;
}

/** Frame shared by every chart: title, source + timeframe caption, legend, and a table view toggle. */
export function ChartCard({
  title,
  caption,
  legend,
  table,
  children,
  className = "",
}: {
  title: string;
  /** Where the numbers come from and the period they cover. Always shown. */
  caption: string;
  legend?: LegendItem[];
  /** Accessible alternative to the chart (same values). */
  table?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section aria-label={title} className={`flex min-w-0 flex-col rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-card ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--color-jarvis-ink)]">{title}</h3>
          <p className="text-[11px] text-[var(--color-jarvis-faint)]">{caption}</p>
        </div>
        {table && (
          <button
            type="button"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-deterministic-accent)] hover:bg-[var(--color-deterministic)]"
          >
            {showTable ? "Chart" : "Table"}
          </button>
        )}
      </header>
      <div className="flex-1 px-4 pb-3 pt-2">{showTable && table ? table : children}</div>
      {legend && legend.length > 1 && !showTable && (
        <ul aria-label={`${title} legend`} className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-jarvis-border)] px-4 py-2 text-[11px] text-[var(--color-jarvis-muted)]">
          {legend.map((l) => (
            <li key={l.key} className="flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />
              {l.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ChartEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full min-h-32 place-items-center rounded-md border border-dashed border-[var(--color-jarvis-border)] px-4 py-6 text-center text-xs text-[var(--color-jarvis-muted)]">
      {children}
    </div>
  );
}

/** Simple accessible data table used as every chart's table view. */
export function DataTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: (string | number)[][] }) {
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full text-left text-xs tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-[var(--color-jarvis-surface)] text-[var(--color-jarvis-muted)]">
          <tr>
            {columns.map((c, i) => (
              <th key={c} scope="col" className={`py-1 pr-3 font-medium ${i > 0 ? "text-right" : ""}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-jarvis-border)]">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} className={`py-1 pr-3 ${j > 0 ? "text-right" : ""}`}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
