import type { AuditEvent } from "../../lib/case-types.ts";
import { describeAuditEvent, type AuditLine } from "../../lib/proof.ts";
import { Panel } from "../ui/Panel.tsx";

const DOT: Record<AuditLine["origin"], string> = {
  system: "bg-[var(--color-jarvis-faint)]",
  input: "bg-[var(--color-jarvis-muted)]",
  ai: "bg-[var(--color-ai-accent)]",
  records: "bg-[var(--color-deterministic-accent)]",
  policy: "bg-[var(--color-policy-accent)]",
  execution: "bg-[var(--color-deterministic-accent)]",
};

const time = (iso: string) => (iso.length >= 23 ? iso.slice(11, 23) : iso);

/** The case's recorded audit trail, every event, in order. Not a live stream. */
export function AuditTimelinePanel({ audit }: { audit: AuditEvent[] }) {
  return (
    <Panel id="audit-stream" title="Audit trail" className="flex max-h-[560px] flex-col overflow-hidden">
      <p className="mb-2 text-[10px] text-[var(--color-jarvis-muted)]">
        {audit.length} recorded events · written by the engine during the run · shown after completion
      </p>
      <div className="overflow-y-auto pr-1">
        <ol className="relative border-l border-[var(--color-jarvis-border)] pl-4" aria-label="Recorded audit events">
          {audit.map((ev) => {
            const line = describeAuditEvent(ev);
            return (
              <li key={ev.seq} className="mb-3 ml-1">
                <span aria-hidden className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${DOT[line.origin]}`} />
                <p className="font-mono text-[10px] text-[var(--color-jarvis-faint)]">
                  #{ev.seq} · {time(ev.at)} · {ev.type}
                </p>
                <p className="text-sm font-medium text-[var(--color-jarvis-ink)]">{line.title}</p>
                {line.detail && <p className="text-xs break-words text-[var(--color-jarvis-muted)]">{line.detail}</p>}
              </li>
            );
          })}
        </ol>
      </div>
    </Panel>
  );
}
