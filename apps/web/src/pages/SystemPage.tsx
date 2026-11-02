import { useEffect, useState } from "react";
import { deriveRuntimeTruth, type HealthPayload } from "../lib/runtime-truth.ts";
import { FIXTURE_BENCHMARK } from "../lib/bench-metrics.ts";
import { Panel, TrustBadge } from "../components/ui/Panel.tsx";

export function SystemPage() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HealthPayload>;
      })
      .then((body) => {
        if (!cancelled) setHealth(body);
      })
      .catch((e) => {
        if (!cancelled) {
          setHealth(null);
          setHealthError(e instanceof Error ? e.message : "Health endpoint unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="motion-fade-in space-y-4">
      <header>
        <h2 className="text-xl font-semibold">AI provider</h2>
        <p className="mt-1 text-sm text-[var(--color-jarvis-muted)]">
          Deployment and capability truth from the running backend. Nothing here invents AMD, Evolus, or production payments.
        </p>
      </header>

      <Panel id="system-truth" title="System truth" badge={<TrustBadge kind="authoritative" />} variant="muted">
        <ul className="space-y-2 text-sm">
          {Object.values(deriveRuntimeTruth(health)).map((t) => (
            <TruthRow
              key={t.label}
              label={t.label}
              value={t.value}
              detail={t.detail}
              ok={t.tone === "ok"}
              warn={t.tone === "warn"}
            />
          ))}
          <TruthRow label="Production payments" value="NOT ENABLED" detail="No real payment integration exists in this build" warn />
          <TruthRow
            label="Benchmark dataset SHA-256"
            value={FIXTURE_BENCHMARK.datasetSha256.slice(0, 16) + "…"}
            detail="Pinned fixture benchmark (not a real-model result)"
            mono
          />
        </ul>
        <p className="mt-4 text-xs text-[var(--color-jarvis-muted)]">
          Labels come from the backend's GET /api/health. A responding model endpoint is not proof of AMD hardware, so
          AMD hardware stays "not verified" until real-run evidence is recorded in docs/AMD_EVIDENCE.md.
        </p>
      </Panel>

      <Panel title="Health probe" variant="muted">
        {health ? (
          <pre className="overflow-x-auto rounded border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-bg)] p-3 font-mono text-[11px] text-[var(--color-jarvis-ink)]">
            {JSON.stringify(health, null, 2)}
          </pre>
        ) : (
          <p className="text-sm text-[var(--color-jarvis-muted)]">
            {healthError ?? "Checking /api/health…"}
            <span className="mt-2 block text-xs">
              The node server, Netlify and Vercel handlers all serve GET /api/health. Without an answer, the labels above
              stay UNKNOWN rather than guessing.
            </span>
          </p>
        )}
      </Panel>
    </div>
  );
}

function TruthRow({
  label,
  value,
  ok,
  warn,
  mono,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
  ok?: boolean;
  warn?: boolean;
  mono?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-jarvis-border)]/60 pb-2 last:border-0">
      <span className="min-w-0">
        <span className="block text-[11px] uppercase tracking-wide text-[var(--color-jarvis-faint)]">{label}</span>
        {detail && <span className="block text-[11px] text-[var(--color-jarvis-muted)]">{detail}</span>}
      </span>
      <span
        className={`text-sm font-medium ${mono ? "font-mono text-xs" : ""} ${
          ok
            ? "text-[var(--color-policy-accent)]"
            : warn
              ? "text-[var(--color-warning)]"
              : "text-[var(--color-jarvis-ink)]"
        }`}
      >
        {value}
      </span>
    </li>
  );
}
