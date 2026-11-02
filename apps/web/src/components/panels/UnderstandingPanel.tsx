import type { StructuredRequest } from "../../lib/case-types.ts";
import { formatMinor } from "../../lib/money.ts";
import { Panel, TrustBadge } from "../ui/Panel.tsx";

export function UnderstandingPanel({ understanding }: { understanding: StructuredRequest | null }) {
  if (!understanding) {
    return (
      <Panel id="understanding-panel" title="Structured understanding" variant="untrusted" badge={<TrustBadge kind="untrusted" />}>
        <p className="text-[var(--color-jarvis-muted)]">Not available for this case.</p>
      </Panel>
    );
  }
  return (
    <Panel id="understanding-panel" title="Structured understanding" variant="untrusted" badge={<TrustBadge kind="untrusted" />}>
      <p className="mb-3 text-[11px] text-[var(--color-ai-accent)]">AI-derived · UNTRUSTED · no CoT shown</p>
      <dl className="space-y-2">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">Interpreted intent</dt>
          <dd className="font-medium">{understanding.intent.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">
            Amounts stated by customer
          </dt>
          <dd>
            {understanding.mentionedAmounts.length === 0 ? (
              <span className="text-[var(--color-jarvis-muted)]">None extracted</span>
            ) : (
              <ul className="list-inside list-disc font-mono text-xs">
                {understanding.mentionedAmounts.map((m, i) => (
                  <li key={i}>
                    {m.text} →{" "}
                    {m.currency != null ? formatMinor(m.amountMinor, m.currency) : `${m.amountMinor} minor (no currency)`}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </Panel>
  );
}
