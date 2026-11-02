import type { Case } from "../../lib/case-types.ts";
import { explainDecision, type DecisionExplanation } from "../../lib/proof.ts";
import { TrustBadge } from "../ui/Panel.tsx";

const TONE: Record<DecisionExplanation["kind"], { surface: string; title: string; mark: string }> = {
  allowed: {
    surface: "border-[var(--color-policy-border)] bg-[var(--color-policy-surface)]",
    title: "text-[var(--color-policy-accent)]",
    mark: "✓",
  },
  blocked: { surface: "border-[var(--color-warning)]/50 bg-[var(--color-warning-surface)]", title: "text-[var(--color-warning)]", mark: "■" },
  "no-action": {
    surface: "border-[var(--color-jarvis-border-strong)] bg-[var(--color-jarvis-surface-2)]",
    title: "text-[var(--color-jarvis-ink)]",
    mark: "–",
  },
  failed: { surface: "border-[var(--color-danger)]/50 bg-[var(--color-danger-surface)]", title: "text-[var(--color-danger)]", mark: "!" },
  "in-progress": {
    surface: "border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)]",
    title: "text-[var(--color-jarvis-ink)]",
    mark: "·",
  },
};

/** Why money did or did not move, stated from the engine's recorded checks and reasons. */
export function DecisionExplainer({ caseData }: { caseData: Case }) {
  const why = explainDecision(caseData);
  if (why.points.length === 0) return null;
  const tone = TONE[why.kind];
  return (
    <section aria-labelledby="decision-why" className={`rounded-md border-2 px-5 py-4 ${tone.surface}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="decision-why" className={`text-lg font-semibold ${tone.title}`}>
          {why.title}
        </h3>
        <TrustBadge kind="deterministic" />
      </div>
      <ul className="mt-3 space-y-1.5">
        {why.points.map((p) => (
          <li key={p} className="flex gap-2.5 text-sm text-[var(--color-jarvis-ink)]">
            <span aria-hidden className={`mt-px font-mono text-xs ${tone.title}`}>
              {tone.mark}
            </span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
