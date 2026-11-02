import type { Case } from "../../lib/case-types.ts";
import { Panel } from "../ui/Panel.tsx";
import { StateBadge } from "../ui/StateBadge.tsx";

export function CaseContextPanel({ caseData, scenarioTitle }: { caseData: Case; scenarioTitle?: string }) {
  return (
    <Panel id="case-context" title="Customer case" badge={<StateBadge state={caseData.state} />}>
      {scenarioTitle && (
        <p className="mb-2 text-xs font-medium text-[var(--color-jarvis-muted)]">Scenario: {scenarioTitle}</p>
      )}
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Case ID</dt>
          <dd className="font-mono text-xs">{caseData.id}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Customer</dt>
          <dd className="font-mono">{caseData.request.customerId}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Order</dt>
          <dd className="font-mono">#{caseData.request.orderId}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Message</dt>
          <dd className="whitespace-pre-wrap rounded border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-bg)]/50 p-2 text-sm">
            {caseData.request.message}
          </dd>
        </div>
      </dl>
    </Panel>
  );
}
