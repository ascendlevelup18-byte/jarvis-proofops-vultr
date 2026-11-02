import type { ReactNode } from "react";

type PanelVariant = "default" | "ai" | "policy" | "deterministic" | "danger" | "muted" | "authoritative" | "untrusted";

const variantClass: Record<PanelVariant, string> = {
  default: "bg-[var(--color-jarvis-surface)] border-[var(--color-jarvis-border)]",
  ai: "bg-[var(--color-ai-surface)] border-[var(--color-ai-border)]",
  policy: "bg-[var(--color-policy-surface)] border-[var(--color-policy-border)]",
  deterministic: "bg-[var(--color-deterministic)] border-[var(--color-deterministic-border)]",
  danger: "bg-[var(--color-danger-surface)] border-[var(--color-danger)]/40",
  muted: "bg-[var(--color-jarvis-surface-2)] border-[var(--color-jarvis-border)]",
  authoritative: "bg-[var(--color-policy-surface)] border-[var(--color-policy-border)]",
  untrusted: "bg-[var(--color-ai-surface)] border-[var(--color-ai-border)]",
};

export function Panel({
  title,
  badge,
  variant = "default",
  children,
  className = "",
  id,
}: {
  title: string;
  badge?: ReactNode;
  variant?: PanelVariant;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`rounded-lg border shadow-card ${variantClass[variant]} ${className}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-inherit px-4 py-2.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-jarvis-muted)]">{title}</h3>
        {badge}
      </header>
      <div className="px-4 py-3 text-sm leading-relaxed text-[var(--color-jarvis-ink)]">{children}</div>
    </section>
  );
}

export function TrustBadge({ kind }: { kind: "authoritative" | "untrusted" | "no-authority" | "simulated" | "deterministic" }) {
  const map = {
    authoritative: {
      label: "Authoritative",
      cls: "border-[var(--color-policy-accent)] bg-[var(--color-policy-accent)]/15 text-[var(--color-policy-accent)]",
    },
    untrusted: {
      label: "Untrusted",
      cls: "border-[var(--color-ai-accent)] bg-[var(--color-ai-accent)]/10 text-[var(--color-ai-accent)]",
    },
    "no-authority": {
      label: "No execution authority",
      cls: "border-[var(--color-ai-accent)] bg-transparent text-[var(--color-ai-accent)]",
    },
    simulated: {
      label: "Simulated",
      cls: "border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 text-[var(--color-warning)]",
    },
    deterministic: {
      label: "Deterministic",
      cls: "border-[var(--color-deterministic-accent)] bg-[var(--color-deterministic-accent)]/10 text-[var(--color-deterministic-accent)]",
    },
  } as const;
  const m = map[kind];
  return (
    <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${m.cls}`}>{m.label}</span>
  );
}
