import type { ReactNode } from "react";
import { btn } from "./styles.ts";

/** Shared building blocks for the light console: page headers, KPI cards, empty states, buttons. */

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-heading flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-[var(--color-jarvis-ink)]">{title}</h2>
        {description && <p className="mt-1 max-w-3xl text-sm text-[var(--color-jarvis-muted)]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({ title, aside, children, className = "", id }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} aria-label={title} className={`rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-card ${className}`}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-jarvis-border)] px-4 py-2.5">
          <h3 className="text-sm font-semibold text-[var(--color-jarvis-ink)]">{title}</h3>
          {aside && <div className="text-xs text-[var(--color-jarvis-faint)]">{aside}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi-card rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] px-4 py-3 shadow-card">
      <dt className="text-xs font-medium text-[var(--color-jarvis-muted)]">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-[var(--color-jarvis-ink)]">{value}</dd>
      {hint && <dd className="mt-0.5 text-[11px] text-[var(--color-jarvis-faint)]">{hint}</dd>}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-jarvis-border-strong)] bg-[var(--color-jarvis-surface)] px-6 py-10 text-center">
      <p className="text-sm font-semibold text-[var(--color-jarvis-ink)]">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-jarvis-muted)]">{body}</p>
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

export function LoadingRows({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-[var(--color-jarvis-surface-2)]" />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorNotice({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-surface)] px-4 py-3 text-sm text-[var(--color-danger)]">
      <span>{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className={btn.secondary}>
          Retry
        </button>
      )}
    </div>
  );
}

const PILL_TONE = {
  success: "bg-[var(--color-policy-surface)] text-[var(--color-policy-accent)] border-[var(--color-policy-border)]",
  warning: "bg-[var(--color-warning-surface)] text-[var(--color-warning)] border-[var(--color-warning)]/30",
  danger: "bg-[var(--color-danger-surface)] text-[var(--color-danger)] border-[var(--color-danger)]/30",
  info: "bg-[var(--color-deterministic)] text-[var(--color-deterministic-accent)] border-[var(--color-deterministic-border)]",
  ai: "bg-[var(--color-ai-surface)] text-[var(--color-ai-accent)] border-[var(--color-ai-border)]",
  neutral: "bg-[var(--color-jarvis-surface-2)] text-[var(--color-jarvis-muted)] border-[var(--color-jarvis-border)]",
} as const;
export type PillTone = keyof typeof PILL_TONE;

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${PILL_TONE[tone]}`}>
      {children}
    </span>
  );
}

/** Segmented control for filters; a radiogroup so state is announced. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 text-xs font-medium ${
            value === o.value
              ? "bg-[var(--color-jarvis-surface)] text-[var(--color-jarvis-ink)] shadow-card"
              : "text-[var(--color-jarvis-muted)] hover:text-[var(--color-jarvis-ink)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
