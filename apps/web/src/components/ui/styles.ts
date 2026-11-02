// Shared class strings for the light console (kept apart from components for fast refresh).

export const btn = {
  primary:
    "inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--color-deterministic-accent)] px-3 py-1.5 text-sm font-semibold text-white shadow-card hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50",
  secondary:
    "inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-jarvis-border-strong)] bg-[var(--color-jarvis-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-jarvis-ink)] shadow-card hover:bg-[var(--color-jarvis-surface-2)] disabled:cursor-not-allowed disabled:opacity-50",
  ghost:
    "inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-[var(--color-deterministic-accent)] hover:bg-[var(--color-deterministic)]",
};

export const inputCls =
  "w-full rounded-md border border-[var(--color-jarvis-border-strong)] bg-[var(--color-jarvis-surface)] px-3 py-1.5 text-sm text-[var(--color-jarvis-ink)] placeholder:text-[var(--color-jarvis-faint)] focus:border-[var(--color-deterministic-accent)] focus:outline-none";
