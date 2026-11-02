import { useState } from "react";
import { Card, PageHeader, Pill } from "../components/ui/Primitives.tsx";
import { btn } from "../components/ui/styles.ts";
import { AUTOMATION_MODULES, type AutomationModule } from "../lib/automations.ts";
import { MAX_RECORDED_CASES } from "../lib/session-store.ts";

/** Workspace settings that genuinely do something in this build. */
export function SettingsPage({
  modules,
  recordedCount,
  onChangeSetup,
  onClearCases,
}: {
  modules: AutomationModule["id"][];
  recordedCount: number;
  onChangeSetup: () => void;
  onClearCases: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="motion-fade-in space-y-4">
      <PageHeader title="Settings" description="Preferences are saved in this browser. AI provider, tokens, and limits are managed on the server." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Automations selected in setup" aside={<button type="button" className={btn.ghost} onClick={onChangeSetup}>Change setup</button>}>
          <ul className="space-y-1.5 text-sm">
            {AUTOMATION_MODULES.filter((m) => modules.includes(m.id)).map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                {m.title}
                <Pill tone={m.status === "operational" ? "success" : "neutral"}>{m.status === "operational" ? "Live" : "Preview"}</Pill>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Recorded cases">
          <p className="text-sm text-[var(--color-jarvis-ink)]">
            <strong className="tabular-nums">{recordedCount}</strong> case{recordedCount === 1 ? "" : "s"} recorded in this browser (newest {MAX_RECORDED_CASES} kept). They are copies of real
            /cases responses and drive Orders, Inbox and Analytics.
          </p>
          {confirming ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-[var(--color-danger)]">Remove all recorded cases from this browser?</span>
              <button
                type="button"
                className={`${btn.secondary} border-[var(--color-danger)]/40 text-[var(--color-danger)]`}
                onClick={() => {
                  onClearCases();
                  setConfirming(false);
                }}
              >
                Remove
              </button>
              <button type="button" className={btn.ghost} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className={`${btn.secondary} mt-3`} disabled={recordedCount === 0} onClick={() => setConfirming(true)}>
              Clear recorded cases
            </button>
          )}
        </Card>
        <Card title="Security boundaries" className="lg:col-span-2">
          <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-jarvis-muted)]">
            <li>No model credentials or operator tokens are present in the browser; the AI provider is configured on the server only.</li>
            <li>The public demo accepts only the four fixed customer requests. Free text needs the server-held operator token.</li>
            <li>Refunds run against a simulated gateway and count as done only after read-back verification.</li>
            <li>Connecting a real store by domain is not available in this build; no external store is read.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
