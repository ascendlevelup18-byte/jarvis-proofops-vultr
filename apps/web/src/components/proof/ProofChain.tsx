import type { Case } from "../../lib/case-types.ts";
import { deriveProofChain, followProofStep, type ProofOrigin, type ProofStage, type ProofStatus } from "../../lib/proof.ts";

const ORIGIN: Record<ProofOrigin, { tag: string; cls: string }> = {
  input: { tag: "Customer input · untrusted", cls: "text-[var(--color-jarvis-muted)]" },
  ai: { tag: "AI · no authority", cls: "text-[var(--color-ai-accent)]" },
  records: { tag: "System of record", cls: "text-[var(--color-deterministic-accent)]" },
  policy: { tag: "Deterministic policy", cls: "text-[var(--color-policy-accent)]" },
  execution: { tag: "Simulated gateway", cls: "text-[var(--color-deterministic-accent)]" },
};

const DONE_SURFACE: Record<ProofOrigin, string> = {
  input: "border-[var(--color-jarvis-border-strong)] bg-[var(--color-jarvis-surface-2)]",
  ai: "border-[var(--color-ai-border)] bg-[var(--color-ai-surface)]",
  records: "border-[var(--color-deterministic-border)] bg-[var(--color-deterministic)]",
  policy: "border-[var(--color-policy-border)] bg-[var(--color-policy-surface)]",
  execution: "border-[var(--color-deterministic-border)] bg-[var(--color-deterministic)]",
};

const STATUS: Record<ProofStatus, { label: string; surface?: string; pill: string }> = {
  done: { label: "Done", pill: "bg-[var(--color-jarvis-bg)]/60 text-[var(--color-jarvis-ink)]" },
  blocked: {
    label: "Blocked",
    surface: "border-[var(--color-warning)]/50 bg-[var(--color-warning-surface)]",
    pill: "bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
  },
  failed: {
    label: "Failed",
    surface: "border-[var(--color-danger)]/50 bg-[var(--color-danger-surface)]",
    pill: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  },
  skipped: {
    label: "Not executed",
    surface: "border-dashed border-[var(--color-jarvis-border)] bg-transparent",
    pill: "bg-[var(--color-jarvis-surface-2)] text-[var(--color-jarvis-muted)]",
  },
  "not-reached": {
    label: "Not reached",
    surface: "border-dashed border-[var(--color-jarvis-border)] bg-transparent opacity-70",
    pill: "bg-[var(--color-jarvis-surface-2)] text-[var(--color-jarvis-faint)]",
  },
};

function StageCard({ stage, index, onOpenStep }: { stage: ProofStage; index: number; onOpenStep?: (anchor: string) => void }) {
  const st = STATUS[stage.status];
  const surface = stage.status === "done" ? DONE_SURFACE[stage.origin] : st.surface;
  return (
    <li className="min-w-0">
      <a
        href={`#${stage.anchor}`}
        onClick={(e) => {
          e.preventDefault();
          followProofStep(stage.anchor, (id) => document.getElementById(id), onOpenStep);
        }}
        aria-label={`Step ${index + 1}: ${stage.label} — ${st.label}. ${stage.headline}. Jump to details.`}
        className={`group flex h-full flex-col rounded-md border px-3 py-2.5 transition-colors hover:border-[var(--color-jarvis-muted)] ${surface}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-[var(--color-jarvis-faint)]">{String(index + 1).padStart(2, "0")}</span>
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${st.pill}`}>{st.label}</span>
        </div>
        <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-jarvis-ink)]">{stage.label}</p>
        <p className={`text-[9px] font-semibold uppercase tracking-wide ${ORIGIN[stage.origin].cls}`}>{ORIGIN[stage.origin].tag}</p>
        <p className="mt-2 text-sm font-semibold leading-snug break-words text-[var(--color-jarvis-ink)]">{stage.headline}</p>
        <p className="mt-1 line-clamp-3 text-xs leading-snug break-words text-[var(--color-jarvis-muted)]">{stage.detail}</p>
        <span className="mt-auto pt-2 text-[10px] text-[var(--color-jarvis-faint)] group-hover:text-[var(--color-jarvis-muted)]">
          Details ↓
        </span>
      </a>
    </li>
  );
}

/** The recorded case as a proof chain: input → AI → records → policy → execution → verification. */
/** onOpenStep: where to go when a step's panel is not on this page (Judge Mode opens the full investigation). */
export function ProofChain({ caseData, onOpenStep }: { caseData: Case; onOpenStep?: (anchor: string) => void }) {
  const stages = deriveProofChain(caseData);
  return (
    <section aria-labelledby="proof-chain-title" className="rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="proof-chain-title" className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-jarvis-muted)]">
          Proof chain
        </h3>
        <p className="text-[10px] text-[var(--color-jarvis-faint)]">
          Recorded during the run, shown after completion · engine order · click a step for its record
        </p>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
        {stages.map((s, i) => (
          <StageCard key={s.id} stage={s} index={i} onOpenStep={onOpenStep} />
        ))}
      </ol>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--color-jarvis-faint)]">
        <span><span className="text-[var(--color-ai-accent)]">■</span> AI output — proposes only</span>
        <span><span className="text-[var(--color-policy-accent)]">■</span> Deterministic policy — decides</span>
        <span><span className="text-[var(--color-deterministic-accent)]">■</span> Records &amp; simulated execution</span>
        <span><span className="text-[var(--color-warning)]">■</span> Blocked by a safeguard</span>
        <span><span className="text-[var(--color-danger)]">■</span> Genuine failure</span>
      </p>
    </section>
  );
}
