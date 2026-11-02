import type { Case } from "../../lib/case-types.ts";
import { WorkflowRail } from "../investigation/WorkflowRail.tsx";
import { AuditTimelinePanel } from "../panels/AuditTimelinePanel.tsx";
import { AuthorizationPanel } from "../panels/AuthorizationPanel.tsx";
import { CaseContextPanel } from "../panels/CaseContextPanel.tsx";
import { EscalationPanel } from "../panels/EscalationPanel.tsx";
import { EvidencePanel } from "../panels/EvidencePanel.tsx";
import { ExecutionPanel, VerificationPanel } from "../panels/ExecutionVerificationPanel.tsx";
import { IntentCuesPanel } from "../panels/IntentCuesPanel.tsx";
import { ProposalPanel } from "../panels/ProposalPanel.tsx";
import { UnderstandingPanel } from "../panels/UnderstandingPanel.tsx";
import { DecisionExplainer } from "../proof/DecisionExplainer.tsx";
import { ProofChain } from "../proof/ProofChain.tsx";
import { MoneyMovementStrip } from "../workspace/MoneyMovementStrip.tsx";
import { VerdictBanner } from "../workspace/VerdictBanner.tsx";

export function InvestigationView({
  caseData,
  scenarioTitle,
  onBack,
  backLabel = "operations",
}: {
  caseData: Case;
  scenarioTitle?: string;
  onBack?: () => void;
  /** Where the back button returns to (page name). */
  backLabel?: string;
}) {
  return (
    <div className="motion-fade-in space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-jarvis-faint)]">
            Case investigation
          </p>
          <h2 className="text-lg font-semibold text-[var(--color-jarvis-ink)]">
            {scenarioTitle ?? `Order #${caseData.request.orderId}`}
          </h2>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="rounded border border-[var(--color-jarvis-border)] px-3 py-1.5 text-xs text-[var(--color-jarvis-muted)] hover:text-[var(--color-jarvis-ink)]"
          >
            ← Back to {backLabel}
          </button>
        )}
      </div>

      <VerdictBanner caseData={caseData} />
      <ProofChain caseData={caseData} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <DecisionExplainer caseData={caseData} />
        <MoneyMovementStrip caseData={caseData} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[200px_1fr]">
        <WorkflowRail caseData={caseData} />
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4">
            <CaseContextPanel caseData={caseData} scenarioTitle={scenarioTitle} />
            <UnderstandingPanel understanding={caseData.understanding} />
            <IntentCuesPanel evidence={caseData.evidence} />
            <EvidencePanel evidence={caseData.evidence} />
          </div>
          <div className="space-y-4">
            <ProposalPanel proposal={caseData.proposal} />
            <AuthorizationPanel authorization={caseData.authorization} />
            <EscalationPanel caseData={caseData} />
          </div>
          <div className="space-y-4">
            <ExecutionPanel action={caseData.action} authorization={caseData.authorization} />
            <VerificationPanel verification={caseData.verification} />
            <AuditTimelinePanel audit={caseData.audit} />
          </div>
        </div>
      </div>
    </div>
  );
}
