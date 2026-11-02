import type { ActionResult, AuthorizationDecision, VerificationResult } from "../../lib/case-types.ts";
import { formatMinor } from "../../lib/money.ts";
import { Panel, TrustBadge } from "../ui/Panel.tsx";

export function ExecutionPanel({
  action,
  authorization,
}: {
  action: ActionResult | null;
  authorization: AuthorizationDecision | null;
}) {
  const locked =
    !action &&
    (authorization?.outcome === "DENY" ||
      authorization?.outcome === "NO_ACTION" ||
      authorization == null);

  if (locked) {
    const currency = "USD";
    const notReached = authorization == null;
    return (
      <Panel id="execution-panel" title="Execution" badge={<TrustBadge kind="simulated" />}>
        <p className="text-base font-bold tracking-wide text-[var(--color-warning)]">
          {notReached ? "EXECUTION NOT REACHED" : "EXECUTION GATE LOCKED"}
        </p>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Dispatched</dt>
            <dd className="font-mono font-semibold">{formatMinor(0, currency)}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Authorization</dt>
            <dd>
              {authorization?.outcome === "DENY"
                ? "Withheld (DENY)"
                : authorization?.outcome === "NO_ACTION"
                  ? "Withheld refund (NO_ACTION)"
                  : notReached
                    ? "Not reached — case ended before policy validation"
                    : "Not approved for execution"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Provider call</dt>
            <dd className="text-[var(--color-jarvis-muted)]">Not attempted · SIMULATED gateway</dd>
          </div>
        </dl>
      </Panel>
    );
  }

  if (!action) {
    return (
      <Panel id="execution-panel" title="Execution" badge={<TrustBadge kind="simulated" />}>
        <p className="text-[var(--color-jarvis-muted)]">No action attempted.</p>
      </Panel>
    );
  }

  return (
    <Panel id="execution-panel" title="Execution" badge={<TrustBadge kind="simulated" />}>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-warning)]">
        Simulated payment gateway — no real money
      </p>
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Status</dt>
          <dd className="font-semibold">{action.status}</dd>
        </div>
        {authorization?.action && (
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">
              Dispatched amount (authorized)
            </dt>
            <dd className="font-mono font-semibold">
              {formatMinor(authorization.action.amountMinor, authorization.action.currency)}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Provider refund ID</dt>
          <dd className="font-mono text-xs">{action.providerRefundId ?? "—"}</dd>
        </div>
        {action.error && (
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Error</dt>
            <dd className="text-[var(--color-danger)]">{action.error}</dd>
          </div>
        )}
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Attempted at</dt>
          <dd className="font-mono text-xs">{action.attemptedAt}</dd>
        </div>
      </dl>
    </Panel>
  );
}

export function VerificationPanel({ verification }: { verification: VerificationResult | null }) {
  if (!verification) {
    return (
      <Panel id="verification-panel" title="Verification">
        <p className="text-[var(--color-jarvis-muted)]">Not performed — no execution to verify.</p>
      </Panel>
    );
  }
  return (
    <Panel id="verification-panel" title="Verification">
      <p
        className={`mb-2 text-lg font-semibold ${
          verification.verified ? "text-[var(--color-policy-accent)]" : "text-[var(--color-danger)]"
        }`}
      >
        {verification.verified ? "Verified by read-back" : "NOT verified — refund unconfirmed"}
      </p>
      <p className="text-sm">{verification.detail}</p>
      {verification.observedRefund && (
        <p className="mt-2 font-mono text-sm font-semibold">
          Observed refund: {formatMinor(verification.observedRefund.amountMinor, verification.observedRefund.currency)}{" "}
          <span className="font-normal text-[var(--color-jarvis-muted)]">
            ({verification.observedRefund.id} · {verification.observedRefund.status})
          </span>
        </p>
      )}
    </Panel>
  );
}
