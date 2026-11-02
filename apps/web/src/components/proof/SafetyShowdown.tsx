import type { DemoScenario } from "../../fixtures/demo-scenarios.ts";
import type { Case } from "../../lib/case-types.ts";
import { deriveProofChain, showdownRows, type ProofStatus } from "../../lib/proof.ts";
import { deriveVerdict } from "../../lib/verdict.ts";
import { StateBadge } from "../ui/StateBadge.tsx";

export interface ShowdownSide {
  scenario: DemoScenario;
  result?: Case;
  error?: string;
}

export interface ShowdownState {
  status: "idle" | "running" | "done";
  safe?: ShowdownSide;
  risky?: ShowdownSide;
}

const DOT: Record<ProofStatus, string> = {
  done: "bg-[var(--color-policy-accent)]",
  blocked: "bg-[var(--color-warning)]",
  failed: "bg-[var(--color-danger)]",
  skipped: "border border-dashed border-[var(--color-jarvis-muted)] bg-transparent",
  "not-reached": "border border-dashed border-[var(--color-jarvis-border)] bg-transparent",
};

function Side({ label, side, onOpen }: { label: string; side?: ShowdownSide; onOpen: (s: ShowdownSide & { result: Case }) => void }) {
  if (!side) return null;
  const c = side.result;
  return (
    <div className="flex min-w-0 flex-col rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-bg)]/40 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-jarvis-faint)]">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-[var(--color-jarvis-ink)]">{side.scenario.title}</p>
      <p className="mt-1 line-clamp-2 text-xs text-[var(--color-jarvis-muted)]">“{side.scenario.request.message}”</p>
      {side.error && (
        <p role="alert" className="mt-3 rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger-surface)] px-3 py-2 text-sm text-[var(--color-danger)]">
          Request failed: {side.error}
        </p>
      )}
      {c && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StateBadge state={c.state} />
            <span className="text-sm font-semibold text-[var(--color-jarvis-ink)]">{deriveVerdict(c).headline}</span>
          </div>
          <ol className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5" aria-label={`${side.scenario.title} proof chain`}>
            {deriveProofChain(c).map((s) => (
              <li key={s.id} className="flex items-center gap-1.5 text-[11px] text-[var(--color-jarvis-muted)]">
                <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[s.status]}`} />
                {s.label}
                <span className="sr-only">: {s.status}</span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => onOpen({ ...side, result: c })}
            className="mt-auto self-start pt-3 text-xs text-[var(--color-deterministic-accent)] underline-offset-2 hover:underline"
          >
            View investigation →
          </button>
        </>
      )}
    </div>
  );
}

/** Two real requests, same AI and policy: one safe duplicate, one the system must refuse. */
export function SafetyShowdown({
  state,
  riskyOptions,
  onRun,
  onOpen,
}: {
  state: ShowdownState;
  riskyOptions: DemoScenario[];
  onRun: (risky: DemoScenario) => void;
  onOpen: (side: ShowdownSide & { result: Case }) => void;
}) {
  const rows = state.safe?.result && state.risky?.result ? showdownRows(state.safe.result, state.risky.result) : null;
  return (
    <section
      aria-labelledby="showdown-title"
      className="showdown-panel rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] px-5 py-5 sm:px-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-jarvis-faint)]">Safety showdown</p>
          <h3 id="showdown-title" className="mt-1 text-xl font-semibold tracking-tight text-[var(--color-jarvis-ink)]">
            Compare a safe and a risky request
          </h3>
          <p className="mt-1 text-sm text-[var(--color-jarvis-muted)]">
            Run both requests to compare the decisions and evidence. Payments are simulated.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Run safety showdown against">
          {riskyOptions.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={state.status === "running"}
              onClick={() => onRun(r)}
              className="rounded border border-[var(--color-deterministic-border)] bg-[var(--color-deterministic)] px-3 py-2 text-xs font-semibold text-[var(--color-jarvis-ink)] transition hover:border-[var(--color-deterministic-accent)] disabled:cursor-wait disabled:opacity-60"
            >
              {state.status === "running" ? "Running…" : `Run vs ${r.title}`}
            </button>
          ))}
        </div>
      </div>

      {state.status !== "idle" && (
        <div className="motion-fade-in mt-5 space-y-4" aria-live="polite">
          <div className="grid gap-3 md:grid-cols-2">
            <Side label="A · should resolve" side={state.safe} onOpen={onOpen} />
            <Side label="B · must not auto-refund" side={state.risky} onOpen={onOpen} />
          </div>
          {rows && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-sm">
                <caption className="sr-only">Side-by-side outcome of both real requests</caption>
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-[var(--color-jarvis-faint)]">
                    <th scope="col" className="py-2 pr-3 font-semibold">Recorded fact</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">A · {state.safe?.scenario.title}</th>
                    <th scope="col" className="py-2 font-semibold">B · {state.risky?.scenario.title}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label} className="border-t border-[var(--color-jarvis-border)]">
                      <th scope="row" className="py-2 pr-3 text-left text-xs font-medium text-[var(--color-jarvis-muted)]">
                        {r.label}
                      </th>
                      <td className="py-2 pr-3 font-mono text-xs text-[var(--color-jarvis-ink)]">{r.a}</td>
                      <td className="py-2 font-mono text-xs text-[var(--color-jarvis-ink)]">{r.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] text-[var(--color-jarvis-faint)]">
                AI mode is shown in the runtime status above. Payments are simulated.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
