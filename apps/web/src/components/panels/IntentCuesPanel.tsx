import type { EvidenceBundle } from "../../lib/case-types.ts";
import { Panel, TrustBadge } from "../ui/Panel.tsx";

export function IntentCuesPanel({ evidence }: { evidence: EvidenceBundle | null }) {
  if (!evidence) {
    return (
      <Panel title="Intent cross-check" variant="deterministic" badge={<TrustBadge kind="deterministic" />}>
        <p className="text-[var(--color-jarvis-muted)]">No evidence bundle.</p>
      </Panel>
    );
  }
  const { intentCues, customerIntent } = evidence;
  return (
    <Panel title="Intent cross-check" variant="deterministic" badge={<TrustBadge kind="deterministic" />}>
      <p className="mb-2 text-[11px] text-[var(--color-deterministic-accent)]">
        Corroboration from raw message — separate from AI understanding
      </p>
      <dl className="space-y-2">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">
            Evidence customer intent
          </dt>
          <dd className="font-medium">{customerIntent.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">
            Duplicate charge cue
          </dt>
          <dd>{intentCues.duplicateCharge ? "Detected" : "Not detected"}</dd>
        </div>
        {intentCues.outOfScope.length > 0 && (
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-[var(--color-jarvis-muted)]">
              Out-of-scope signals
            </dt>
            <dd>
              <ul className="list-inside list-disc text-xs">
                {intentCues.outOfScope.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </Panel>
  );
}
