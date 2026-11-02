import type { Case, CaseState } from "../../lib/case-types.ts";
import { executionStarted, stoppedFromState } from "../../lib/verdict.ts";

const STAGES = [
  { id: "UNDERSTAND", label: "Understand", states: ["RECEIVED", "EXTRACTING"] as CaseState[] },
  { id: "EVIDENCE", label: "Evidence", states: ["EVIDENCE_GATHERING"] as CaseState[] },
  { id: "PROPOSE", label: "Propose", states: ["ANALYZING", "DECISION_PROPOSED"] as CaseState[] },
  { id: "AUTHORIZE", label: "Authorize", states: ["POLICY_VALIDATION", "APPROVED"] as CaseState[] },
  { id: "ACT", label: "Execute", states: ["EXECUTING"] as CaseState[] },
  { id: "VERIFY", label: "Verify", states: ["VERIFYING", "RESOLVED"] as CaseState[] },
] as const;

type StageId = (typeof STAGES)[number]["id"];

function visitedStates(caseData: Case): Set<CaseState> {
  const seen = new Set<CaseState>();
  for (const ev of caseData.audit) {
    if (ev.type === "STATE_TRANSITION" && ev.to) seen.add(ev.to as CaseState);
  }
  seen.add(caseData.state);
  return seen;
}

function stageReached(visited: Set<CaseState>, stageStates: readonly CaseState[]): boolean {
  return stageStates.some((s) => visited.has(s));
}

function stageForState(state: CaseState | null): StageId | null {
  if (!state) return null;
  for (const stage of STAGES) {
    if (stage.states.includes(state)) return stage.id;
  }
  return null;
}

function footerText(caseData: Case, stoppedStage: StageId | null): string | null {
  const { state, authorization, reasons } = caseData;
  if (state === "CLOSED_NO_ACTION") {
    return "Stopped at AUTHORIZE — NO_ACTION (success path, not a failure)";
  }
  if (state === "ESCALATED") {
    if (authorization?.outcome === "DENY") return "Stopped at AUTHORIZE — execution never opened";
    if (reasons.some((r) => r.code === "STALE_EVIDENCE")) {
      return "Stopped at AUTHORIZE — pre-execution revalidation failed";
    }
    return "Stopped at EVIDENCE — escalated before any proposal";
  }
  if (state === "FAILED") {
    if (!executionStarted(caseData)) {
      return `Stopped at ${stoppedStage ?? "UNKNOWN"} — execution never opened`;
    }
    return "Execution attempted — read-back did not confirm the refund";
  }
  return null;
}

/** Vertical workflow rail from actual audit / state — not a live stream. */
export function WorkflowRail({ caseData }: { caseData: Case }) {
  const visited = visitedStates(caseData);
  const finalState = caseData.state;
  const blocked = finalState === "ESCALATED" || finalState === "FAILED";
  const closed = finalState === "CLOSED_NO_ACTION";
  const resolved = finalState === "RESOLVED";

  const stopped = stoppedFromState(caseData);
  let stoppedStage = stageForState(stopped);

  if (closed) stoppedStage = "AUTHORIZE";
  if (finalState === "ESCALATED" && caseData.authorization?.outcome === "DENY") stoppedStage = "AUTHORIZE";
  if (finalState === "ESCALATED" && caseData.reasons.some((r) => r.code === "STALE_EVIDENCE")) {
    stoppedStage = "AUTHORIZE";
  }
  if (
    finalState === "ESCALATED" &&
    caseData.authorization == null &&
    !caseData.reasons.some((r) => r.code === "STALE_EVIDENCE")
  ) {
    stoppedStage = "EVIDENCE";
  }
  if (finalState === "FAILED" && executionStarted(caseData)) stoppedStage = "VERIFY";

  const stoppedIdx = stoppedStage ? STAGES.findIndex((s) => s.id === stoppedStage) : -1;
  const footer = footerText(caseData, stoppedStage);

  return (
    <aside
      className="rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] px-3 py-4"
      aria-label="Workflow rail"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-jarvis-faint)]">
          Workflow
        </h3>
        <span className="text-[9px] text-[var(--color-jarvis-faint)]">From audit</span>
      </div>
      <ol className="space-y-0">
        {STAGES.map((stage, idx) => {
          let hit = stageReached(visited, stage.states);
          if (stage.id === "AUTHORIZE" && closed) hit = true;
          if (stage.id === "VERIFY" && resolved) hit = true;
          if (stoppedIdx >= 0 && idx > stoppedIdx) hit = false;
          if (stoppedIdx >= 0 && idx === stoppedIdx) hit = true;
          if ((stage.id === "ACT" || stage.id === "VERIFY") && (blocked || closed) && !visited.has("EXECUTING")) {
            hit = false;
          }
          if (stage.id === "VERIFY" && finalState === "FAILED" && executionStarted(caseData)) hit = true;

          const isStop = stoppedIdx >= 0 && idx === stoppedIdx && (blocked || closed);
          let dot = "bg-[var(--color-jarvis-faint)]";
          let text = "text-[var(--color-jarvis-faint)]";
          if (hit && !isStop) {
            dot = "bg-[var(--color-jarvis-ink)]";
            text = "text-[var(--color-jarvis-ink)]";
          }
          if (isStop && blocked) {
            dot = "bg-[var(--color-warning)]";
            text = "text-[var(--color-warning)] font-semibold";
          }
          if (isStop && closed) {
            dot = "bg-[var(--color-jarvis-muted)]";
            text = "text-[var(--color-jarvis-ink)] font-semibold";
          }
          if (hit && stage.id === "VERIFY" && resolved) {
            dot = "bg-[var(--color-policy-accent)]";
            text = "text-[var(--color-policy-accent)] font-semibold";
          }

          return (
            <li key={stage.id} className="relative flex gap-3 pb-4 last:pb-0">
              {idx < STAGES.length - 1 && (
                <span
                  className="absolute left-[5px] top-3 h-[calc(100%-4px)] w-px bg-[var(--color-jarvis-border)]"
                  aria-hidden
                />
              )}
              <span className={`relative z-[1] mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full ${dot}`} aria-hidden />
              <div>
                <p className={`text-xs ${text}`}>{stage.label}</p>
                {isStop && <p className="text-[10px] text-[var(--color-jarvis-muted)]">Stop</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {footer && (
        <p className={`mt-3 border-t border-[var(--color-jarvis-border)] pt-3 text-[11px] ${blocked ? "text-[var(--color-warning)]" : "text-[var(--color-jarvis-muted)]"}`}>
          {footer}
        </p>
      )}
    </aside>
  );
}
