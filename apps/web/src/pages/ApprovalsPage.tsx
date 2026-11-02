import { EmptyState, PageHeader, Pill } from "../components/ui/Primitives.tsx";
import { StateBadge } from "../components/ui/StateBadge.tsx";
import { btn } from "../components/ui/styles.ts";
import { formatMinor } from "../lib/money.ts";
import { explainDecision } from "../lib/proof.ts";
import type { SessionCaseEntry } from "../lib/session-store.ts";
import { CHECK_LABELS, REASON_LABELS } from "../lib/verdict.ts";

/** Review queue of cases JARVIS routed to a person. Review-only: there is no approve-and-execute path. */
export function ApprovalsPage({ history, onOpenCase }: { history: SessionCaseEntry[]; onOpenCase: (e: SessionCaseEntry) => void }) {
  const queue = history.filter((h) => h.state === "ESCALATED" || h.state === "FAILED");
  return (
    <div className="motion-fade-in space-y-4">
      <PageHeader
        title="Approvals"
        description="Cases that need a person. Review only; refunds cannot be approved here. Resolve these cases outside JARVIS."
        actions={<Pill tone="warning">Review-only</Pill>}
      />
      {queue.length === 0 ? (
        <EmptyState
          title="Nothing waiting for review"
          body="Escalations appear here when JARVIS refuses an unsafe or unclear request. Try order #48294 in the demo store."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-card">
          <table className="w-full min-w-[920px] text-left text-sm">
            <caption className="sr-only">Cases awaiting human review, {queue.length} total</caption>
            <thead className="border-b border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)] text-xs text-[var(--color-jarvis-muted)]">
              <tr>
                {["Case", "Customer · order", "Requested action", "Evidence summary", "Policy reason", "Status", ""].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-jarvis-border)] align-top">
              {queue.map((entry) => {
                const c = entry.caseData;
                const failed = c.authorization?.checks.filter((k) => !k.passed) ?? [];
                const reason = failed.length
                  ? failed.map((k) => CHECK_LABELS[k.rule] ?? k.rule).join(", ")
                  : c.reasons.map((r) => REASON_LABELS[r.code] ?? r.code).join(", ") || "—";
                const requested = c.understanding?.mentionedAmounts.length
                  ? `Refund · customer states ${c.understanding.mentionedAmounts.map((m) => (m.currency ? formatMinor(m.amountMinor, m.currency) : m.text)).join(", ")}`
                  : c.understanding
                    ? `Refund (${c.understanding.intent.replaceAll("_", " ").toLowerCase()})`
                    : "Not understood";
                const ev = c.evidence;
                return (
                  <tr key={entry.id}>
                    <td className="px-3 py-2.5">
                      <span className="block font-mono text-[11px]">{entry.id.slice(0, 13)}…</span>
                      <span className="text-[11px] text-[var(--color-jarvis-faint)]">
                        {entry.source === "storefront" ? "from demo store" : "from console"} · {new Date(entry.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {ev?.customer.name ?? entry.customerId}
                      <span className="block text-xs text-[var(--color-jarvis-muted)]">#{entry.orderId}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {requested}
                      {c.proposal && <span className="block text-[var(--color-ai-accent)]">AI proposed: {c.proposal.action.replaceAll("_", " ").toLowerCase()}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--color-jarvis-muted)]">
                      {ev
                        ? `${ev.transactions.length} charges · ${ev.financial.status.replaceAll("_", " ").toLowerCase()}${ev.contradictions.length ? ` · ${ev.contradictions.length} contradiction` : ""}`
                        : "No evidence gathered"}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      <span className="font-semibold text-[var(--color-warning)]">{reason}</span>
                      <span className="block text-[var(--color-jarvis-muted)]">{explainDecision(c).points[0]}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <StateBadge state={entry.state} />
                      <span className="mt-1 block text-[11px] text-[var(--color-jarvis-faint)]">Awaiting a person · $0.00 moved</span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button type="button" className={btn.ghost} onClick={() => onOpenCase(entry)}>
                        Review evidence
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
