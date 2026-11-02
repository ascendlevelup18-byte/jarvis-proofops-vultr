import { useState } from "react";
import type { AuthorizationDecision } from "../../lib/case-types.ts";
import { formatMinor } from "../../lib/money.ts";
import { Panel, TrustBadge } from "../ui/Panel.tsx";

export function AuthorizationPanel({ authorization }: { authorization: AuthorizationDecision | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!authorization) {
    return (
      <Panel title="Deterministic authorization" variant="policy" badge={<TrustBadge kind="authoritative" />}>
        <p className="text-[var(--color-jarvis-muted)]">Not evaluated.</p>
      </Panel>
    );
  }

  const passed = authorization.checks.filter((c) => c.passed);
  const failed = authorization.checks.filter((c) => !c.passed);
  const allPass = failed.length === 0;
  const total = authorization.checks.length;

  const outcomeStyle =
    authorization.outcome === "APPROVE"
      ? "text-[var(--color-policy-accent)]"
      : authorization.outcome === "DENY"
        ? "text-[var(--color-danger)]"
        : "text-[var(--color-jarvis-ink)]";

  return (
    <Panel
      id="authorization-gate"
      title="Deterministic authorization"
      variant="policy"
      badge={<TrustBadge kind="authoritative" />}
    >
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-policy-accent)]">
        AI proposes · POLICY authorizes
      </p>
      <p className={`mb-3 text-xl font-bold ${outcomeStyle}`}>Outcome: {authorization.outcome}</p>

      {allPass ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--color-policy-accent)]">
            {passed.length} / {total} policy checks passed
          </p>
          <button
            type="button"
            className="text-xs text-[var(--color-policy-accent)] underline-offset-2 hover:underline"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide checks" : "Show all checks"}
          </button>
          {expanded && <CheckList checks={authorization.checks} />}
        </div>
      ) : (
        <div className="space-y-3">
          <CheckList checks={failed} />
          <p className="text-sm text-[var(--color-jarvis-muted)]">
            {passed.length} additional check{passed.length === 1 ? "" : "s"} passed
            {passed.length > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  className="text-[var(--color-policy-accent)] underline-offset-2 hover:underline"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? "Hide" : "Show"}
                </button>
              </>
            )}
          </p>
          {expanded && passed.length > 0 && <CheckList checks={passed} compact />}
        </div>
      )}

      {authorization.action && (
        <div className="mt-4 rounded border border-[var(--color-policy-border)] bg-[var(--color-jarvis-bg)]/40 p-3">
          <p className="text-[10px] font-semibold uppercase text-[var(--color-policy-accent)]">
            Authorized refund action
          </p>
          <p className="mt-1 font-mono text-sm">
            {authorization.action.transactionId} ·{" "}
            {formatMinor(authorization.action.amountMinor, authorization.action.currency)}
          </p>
        </div>
      )}
      {authorization.outcome === "DENY" && !authorization.action && (
        <p className="mt-4 text-sm font-medium text-[var(--color-danger)]">
          Authorization withheld — no refund action issued
        </p>
      )}
      {authorization.outcome === "NO_ACTION" && (
        <p className="mt-4 text-sm font-medium text-[var(--color-jarvis-muted)]">
          No refund action issued (NO_ACTION)
        </p>
      )}
    </Panel>
  );
}

function CheckList({
  checks,
  compact = false,
}: {
  checks: AuthorizationDecision["checks"];
  compact?: boolean;
}) {
  return (
    <ul className="space-y-2">
      {checks.map((c) => (
        <li
          key={c.rule}
          className={`flex gap-3 rounded border px-3 py-2 text-sm ${
            c.passed
              ? "border-[var(--color-policy-border)]/50 bg-[var(--color-jarvis-bg)]/30"
              : "border-[var(--color-danger)]/40 bg-[var(--color-danger-surface)]"
          } ${compact ? "opacity-80" : ""}`}
        >
          <span
            className={`mt-0.5 shrink-0 text-[10px] font-bold uppercase ${
              c.passed ? "text-[var(--color-policy-accent)]" : "text-[var(--color-danger)]"
            }`}
          >
            {c.passed ? "PASS" : "FAIL"}
          </span>
          <div>
            <p className="font-mono text-xs font-semibold">{c.rule}</p>
            {!compact && <p className="text-xs text-[var(--color-jarvis-muted)]">{c.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}
