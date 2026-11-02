import { useMemo, useState } from "react";
import { EmptyState, PageHeader, Pill, Segmented, type PillTone } from "../components/ui/Primitives.tsx";
import { StateBadge } from "../components/ui/StateBadge.tsx";
import { btn, inputCls } from "../components/ui/styles.ts";
import { describeAuditEvent, type ProofOrigin } from "../lib/proof.ts";
import type { SessionCaseEntry } from "../lib/session-store.ts";

type Kind = "all" | "ai" | "policy" | "execution" | "transitions";
const KIND_OF = (type: string): Exclude<Kind, "all"> =>
  type === "UNDERSTANDING_CALL" || type === "MODEL_CALL"
    ? "ai"
    : type === "POLICY_EVALUATED"
      ? "policy"
      : type === "ACTION_ATTEMPTED" || type === "VERIFICATION"
        ? "execution"
        : "transitions";
const ORIGIN_TONE: Record<ProofOrigin | "system", PillTone> = { input: "neutral", ai: "ai", records: "neutral", policy: "success", execution: "info", system: "neutral" };
const ORIGIN_LABEL: Record<ProofOrigin | "system", string> = { input: "Input", ai: "AI", records: "Records", policy: "Policy", execution: "Execution", system: "Engine" };

/** Engine audit events of every recorded case: filter by event kind or case, trace request → verification. */
export function ActivityPage({ history, onOpenCase }: { history: SessionCaseEntry[]; onOpenCase: (e: SessionCaseEntry) => void }) {
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(history[0]?.id ?? null);
  const needle = q.trim().toLowerCase().replace(/^#/, "");
  const cases = useMemo(
    () => history.filter((h) => !needle || h.id.toLowerCase().includes(needle) || h.orderId.includes(needle) || h.customerId.toLowerCase().includes(needle)),
    [history, needle],
  );
  const totalEvents = history.reduce((n, h) => n + h.caseData.audit.length, 0);

  return (
    <div className="motion-fade-in space-y-4">
      <PageHeader
        title="Audit trail"
        description={`Recorded events for the ${history.length} case${history.length === 1 ? "" : "s"} in this browser (${totalEvents} events). Available after each case completes.`}
      />
      {history.length === 0 ? (
        <EmptyState title="No audit events yet" body="Run a case from the demo store or Proof Mode; its full engine audit appears here." />
      ) : (
        <>
          <div role="group" aria-label="Audit filters" className="flex flex-wrap items-center gap-2">
            <div className="min-w-48 sm:max-w-xs">
              <label htmlFor="audit-search" className="sr-only">
                Filter by case, order or customer
              </label>
              <input id="audit-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Case ID, order or customer" className={inputCls} />
            </div>
            <Segmented
              label="Event kind"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "All events" },
                { value: "ai", label: "AI calls" },
                { value: "policy", label: "Policy" },
                { value: "execution", label: "Execution & verification" },
                { value: "transitions", label: "State changes" },
              ]}
            />
          </div>
          {cases.length === 0 ? (
            <EmptyState title="No cases match" body="Clear the filter to see every recorded case." />
          ) : (
            <ul className="space-y-2">
              {cases.map((entry) => {
                const events = entry.caseData.audit.filter((e) => kind === "all" || KIND_OF(e.type) === kind);
                const expanded = open === entry.id || cases.length === 1;
                return (
                  <li key={entry.id} className="rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-card">
                    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : entry.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span aria-hidden className="text-[var(--color-jarvis-faint)]">
                          {expanded ? "▾" : "▸"}
                        </span>
                        <StateBadge state={entry.state} />
                        <span className="truncate text-sm font-medium">Order #{entry.orderId}</span>
                        <span className="hidden truncate font-mono text-[11px] text-[var(--color-jarvis-faint)] sm:inline">{entry.id}</span>
                      </button>
                      <span className="text-xs text-[var(--color-jarvis-muted)]">
                        {events.length} of {entry.caseData.audit.length} events
                      </span>
                      <button type="button" className={btn.ghost} onClick={() => onOpenCase(entry)}>
                        Open case
                      </button>
                    </div>
                    {expanded && (
                      <ol aria-label={`Audit events for case ${entry.id}`} className="divide-y divide-[var(--color-jarvis-border)] border-t border-[var(--color-jarvis-border)]">
                        {events.map((ev) => {
                          const line = describeAuditEvent(ev);
                          return (
                            <li key={ev.seq} className="flex flex-wrap items-start gap-x-3 gap-y-0.5 px-4 py-1.5 text-xs">
                              <span className="w-8 shrink-0 tabular-nums text-[var(--color-jarvis-faint)]">#{ev.seq}</span>
                              <span className="w-24 shrink-0 tabular-nums text-[var(--color-jarvis-faint)]">{ev.at.slice(11, 23)}</span>
                              <Pill tone={ORIGIN_TONE[line.origin]}>{ORIGIN_LABEL[line.origin]}</Pill>
                              <span className="min-w-0 flex-1">
                                <span className="font-medium text-[var(--color-jarvis-ink)]">{line.title}</span>
                                {line.detail && <span className="text-[var(--color-jarvis-muted)]"> · {line.detail}</span>}
                              </span>
                            </li>
                          );
                        })}
                        {events.length === 0 && <li className="px-4 py-2 text-xs text-[var(--color-jarvis-muted)]">No events of this kind.</li>}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
