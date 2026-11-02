import { Card, PageHeader, Pill } from "../components/ui/Primitives.tsx";
import { btn } from "../components/ui/styles.ts";
import { AUTOMATION_MODULES, type AutomationModule } from "../lib/automations.ts";
import { countByState, type SessionCaseEntry } from "../lib/session-store.ts";

const WORKFLOW: { step: string; who: "Input" | "Records" | "AI" | "Policy" | "Execution" | "System"; detail: string }[] = [
  { step: "Trigger", who: "Input", detail: "Customer request from the demo store or a fixed scenario (untrusted text)" },
  { step: "Evidence", who: "Records", detail: "Order, payment and refund records from the system of record" },
  { step: "AI interpretation", who: "AI", detail: "Structured understanding and a proposal; no authority to act" },
  { step: "Policy", who: "Policy", detail: "Deterministic checks decide APPROVE, DENY or NO_ACTION; amounts come from records" },
  { step: "Action", who: "Execution", detail: "Approved refunds go to the simulated gateway after revalidation" },
  { step: "Verification", who: "Execution", detail: "Read-back must observe the refund before the case can resolve" },
  { step: "Audit", who: "System", detail: "Every step is recorded as an engine audit event" },
];
const WHO_TONE = { Input: "neutral", Records: "neutral", AI: "ai", Policy: "success", Execution: "info", System: "neutral" } as const;

/** Automation catalog: what genuinely runs, what each module needs, and the flagship workflow. */
export function AutomationsPage({
  enabled,
  history,
  onOpenStore,
  onOpenProof,
  onOpenCases,
}: {
  enabled: AutomationModule["id"][];
  history: SessionCaseEntry[];
  onOpenStore: () => void;
  onOpenProof: () => void;
  onOpenCases: () => void;
}) {
  const counts = countByState(history);
  const live = AUTOMATION_MODULES.filter((m) => m.status === "operational");
  const previews = AUTOMATION_MODULES.filter((m) => m.status === "preview");
  return (
    <div className="motion-fade-in space-y-5">
      <PageHeader
        title="Automation catalog"
        description="Active automations use simulated payments. Preview modules are planned and cannot run."
      />

      {live.map((m) => (
        <Card key={m.id} title={m.title} aside={<Pill tone="success">Active · simulated payments</Pill>}>
          <p className="text-sm text-[var(--color-jarvis-ink)]">{m.summary}</p>
          <p className="mt-1 text-xs text-[var(--color-jarvis-muted)]">{m.reality}</p>
          <ol aria-label="Refund workflow" className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
            {WORKFLOW.map((w, i) => (
              <li key={w.step} className="relative rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)] p-2.5">
                <p className="flex items-center justify-between gap-1 text-[11px] text-[var(--color-jarvis-faint)]">
                  <span className="tabular-nums">{i + 1}</span>
                  <Pill tone={WHO_TONE[w.who]}>{w.who}</Pill>
                </p>
                <p className="mt-1 text-sm font-semibold text-[var(--color-jarvis-ink)]">{w.step}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-jarvis-muted)]">{w.detail}</p>
              </li>
            ))}
          </ol>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold text-[var(--color-jarvis-muted)]">Requirements</h4>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {m.requirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-[var(--color-jarvis-muted)]">Recorded activity</h4>
              <p className="mt-1 text-sm">
                {history.length} case{history.length === 1 ? "" : "s"} · {counts.RESOLVED} resolved · {counts.ESCALATED} escalated · {counts.CLOSED_NO_ACTION} no action · {counts.FAILED} failed
              </p>
              <p className="text-[11px] text-[var(--color-jarvis-faint)]">{enabled.includes(m.id) ? "Selected in setup" : "Not selected in setup"}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={btn.primary} onClick={onOpenStore}>
              Try it from the demo store
            </button>
            <button type="button" className={btn.secondary} onClick={onOpenProof}>
              Open Proof Mode
            </button>
            <button type="button" className={btn.secondary} onClick={onOpenCases}>
              View cases
            </button>
          </div>
        </Card>
      ))}

      <section aria-labelledby="previews-title" className="space-y-2">
        <h3 id="previews-title" className="text-sm font-semibold text-[var(--color-jarvis-ink)]">
          Previews · not built
        </h3>
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {previews.map((m) => (
            <li key={m.id} className="rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] p-4 shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">{m.title}</h4>
                <Pill tone="neutral">Preview</Pill>
              </div>
              <p className="mt-1 text-sm">{m.summary}</p>
              <p className="mt-1 text-xs text-[var(--color-jarvis-muted)]">{m.reality}</p>
              <p className="mt-2 text-[11px] font-medium text-[var(--color-jarvis-muted)]">Would need</p>
              <ul className="list-disc pl-5 text-xs text-[var(--color-jarvis-muted)]">
                {m.requirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-[var(--color-jarvis-faint)]">{enabled.includes(m.id) ? "Selected in setup · no actions available" : "No actions available"}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
