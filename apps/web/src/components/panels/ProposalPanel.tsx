import type { DecisionProposal } from "../../lib/case-types.ts";
import { Panel, TrustBadge } from "../ui/Panel.tsx";

export function ProposalPanel({ proposal }: { proposal: DecisionProposal | null }) {
  if (!proposal) {
    return (
      <Panel title="AI proposal" variant="ai" badge={<TrustBadge kind="no-authority" />}>
        <p className="text-[var(--color-jarvis-muted)]">No proposal recorded.</p>
      </Panel>
    );
  }
  return (
    <Panel id="ai-proposal" title="AI proposal" variant="ai" badge={<TrustBadge kind="no-authority" />}>
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ai-accent)]">
        No execution authority
      </p>
      <dl className="space-y-2">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Proposed action</dt>
          <dd className="text-lg font-semibold">{proposal.action.replaceAll("_", " ")}</dd>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-[var(--color-jarvis-muted)]">Refund txn (if any)</dt>
            <dd className="font-mono">{proposal.refundTransactionId ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-jarvis-muted)]">Keep txn</dt>
            <dd className="font-mono">{proposal.keepTransactionId ?? "—"}</dd>
          </div>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Rationale</dt>
          <dd className="text-sm">{proposal.rationale}</dd>
        </div>
        {proposal.riskFlags.length > 0 && (
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Risk flags</dt>
            <dd className="flex flex-wrap gap-1">
              {proposal.riskFlags.map((f) => (
                <span
                  key={f}
                  className="rounded border border-[var(--color-ai-border)] bg-[var(--color-jarvis-bg)]/50 px-1.5 py-0.5 text-xs"
                >
                  {f}
                </span>
              ))}
            </dd>
          </div>
        )}
        <div className="border-t border-[var(--color-ai-border)]/50 pt-2">
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Model confidence</dt>
          <dd className="text-xs text-[var(--color-jarvis-muted)]">
            {(proposal.confidence * 100).toFixed(0)}% · advisory only
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Evidence refs</dt>
          <dd className="font-mono text-[10px] leading-relaxed text-[var(--color-jarvis-muted)]">
            {proposal.evidenceRefs.join(", ") || "—"}
          </dd>
        </div>
      </dl>
    </Panel>
  );
}
