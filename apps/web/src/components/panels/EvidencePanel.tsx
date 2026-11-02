import type { EvidenceBundle } from "../../lib/case-types.ts";
import { formatMinor } from "../../lib/money.ts";
import { Panel, TrustBadge } from "../ui/Panel.tsx";

export function EvidencePanel({ evidence }: { evidence: EvidenceBundle | null }) {
  if (!evidence) {
    return (
      <Panel id="evidence-panel" title="Evidence" badge={<TrustBadge kind="authoritative" />} variant="authoritative">
        <p className="text-[var(--color-jarvis-muted)]">Not gathered.</p>
      </Panel>
    );
  }
  return (
    <Panel
      id="evidence-panel"
      title="Evidence"
      badge={<TrustBadge kind="authoritative" />}
      variant="authoritative"
    >
      <p className="mb-3 text-[11px] text-[var(--color-jarvis-muted)]">
        Record-sourced facts at intake, before any action · AUTHORITATIVE · not model output
      </p>
      <div className="space-y-4">
        <section>
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-faint)]">
            Financial state at intake
          </h4>
          <p className="font-mono text-sm">
            {formatMinor(evidence.financial.netPaidMinor, evidence.order.currency)} net paid · order total{" "}
            {formatMinor(evidence.financial.orderTotalMinor, evidence.order.currency)} ·{" "}
            <span className="font-sans font-medium">{evidence.financial.status.replaceAll("_", " ")}</span>
          </p>
        </section>
        <section>
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-faint)]">
            Customer / order
          </h4>
          <p className="font-mono text-xs">
            {evidence.customer.id} · {evidence.customer.name} · order #{evidence.order.id}
          </p>
        </section>
        <section>
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-faint)]">
            Transactions
          </h4>
          <ul className="space-y-1 font-mono text-xs">
            {evidence.transactions.map((t) => (
              <li key={t.id} className="rounded border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-bg)]/40 px-2 py-1">
                {t.id}: {formatMinor(t.amountMinor, t.currency)} · {t.status}
                {t.refundedMinor > 0 ? ` · refunded ${formatMinor(t.refundedMinor, t.currency)}` : ""}
              </li>
            ))}
          </ul>
        </section>
        {evidence.duplicateGroups.length > 0 && (
          <section>
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-faint)]">
              Duplicate groups
            </h4>
            {evidence.duplicateGroups.map((g, i) => (
              <p key={i} className="font-mono text-xs">
                {g.transactionIds.join(", ")} — {formatMinor(g.amountMinor, g.currency)}
              </p>
            ))}
          </section>
        )}
        {evidence.contradictions.length > 0 && (
          <section className="rounded border border-[var(--color-danger)]/35 bg-[var(--color-danger-surface)] p-2">
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-danger)]">
              Contradictions
            </h4>
            <ul className="mt-1 list-inside list-disc text-xs text-[var(--color-jarvis-ink)]/90">
              {evidence.contradictions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-jarvis-faint)]">
            Policy source
          </h4>
          <p className="text-xs">
            {evidence.policy.id} v{evidence.policy.version}
          </p>
          <p className="mt-1 font-mono text-[10px] text-[var(--color-jarvis-muted)]">
            sources: {evidence.sourceIds.join(", ") || "—"}
          </p>
        </section>
      </div>
    </Panel>
  );
}
