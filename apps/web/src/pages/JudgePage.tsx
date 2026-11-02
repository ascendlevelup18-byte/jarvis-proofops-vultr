import { useCallback, useEffect, useRef, useState } from "react";
import { submitCase, ApiError } from "../lib/api.ts";
import type { Case } from "../lib/case-types.ts";
import { canRunFixture, missionOutcome } from "../lib/command-center.ts";
import type { HealthPayload } from "../lib/runtime-truth.ts";
import { loadHealth } from "../lib/use-runtime-health.ts";
import { DEMO_SCENARIOS, type DemoScenario } from "../fixtures/demo-scenarios.ts";
import { EVIDENCE_FILES, RECORDED_RUN, evidenceUrl, replayTimeline } from "../lib/recorded-amd-run.ts";
import { BASELINE_FILE, NO_POLICY_BASELINE } from "../lib/baseline-result.ts";
import { LATEST_EVIDENCE_FILES, LATEST_RUN } from "../lib/latest-amd-run.ts";
import { DecisionExplainer } from "../components/proof/DecisionExplainer.tsx";
import { MerchantImpact } from "../components/judge/MerchantImpact.tsx";
import { StressLab } from "../components/judge/StressLab.tsx";
import { ProofChain } from "../components/proof/ProofChain.tsx";
import { StateBadge } from "../components/ui/StateBadge.tsx";
import { btn } from "../components/ui/styles.ts";
import "./judge.css";

// The four outcomes a judge should verify, in the order they tell the story.
const VERDICTS: { scenarioId: string; headline: string; expected: string }[] = [
  { scenarioId: "valid-duplicate", headline: "Duplicate $89.99 charge", expected: "RESOLVED" },
  { scenarioId: "prompt-injection", headline: "Adversarial $5,000 demand", expected: "ESCALATED" },
  { scenarioId: "already-refunded", headline: "Already refunded", expected: "CLOSED_NO_ACTION" },
  { scenarioId: "conflicting-amount", headline: "Contradicted amount: $250 claimed, $180 charged", expected: "ESCALATED" },
];

type Slot = { status: "idle" } | { status: "running" } | { status: "done"; result: Case } | { status: "error"; error: string };

const AUTHORITY_STEPS: { label: string; who: "input" | "ai" | "code"; detail: string }[] = [
  { label: "Customer request", who: "input", detail: "Untrusted text. Amounts and instructions in it carry no authority." },
  { label: "Understanding", who: "ai", detail: "The model classifies intent and extracts stated amounts into a strict schema." },
  { label: "Evidence", who: "code", detail: "Charges, refunds and duplicate groups are read from the system of record." },
  { label: "AI proposal", who: "ai", detail: "The model proposes refund, no action or escalate, citing evidence ids. It cannot set the amount." },
  { label: "Policy authorization", who: "code", detail: "Deterministic checks: evidence coherence, amount from records, thresholds, permissions, state revalidation." },
  { label: "Simulated execution", who: "code", detail: "Idempotent call to a simulated gateway. No real money moves." },
  { label: "Read-back verification", who: "code", detail: "The refund is read back and must match the authorized charge, amount and currency." },
  { label: "Audit", who: "code", detail: "Every stage is recorded with a contiguous sequence number." },
];

const money = (minor: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

async function readHealth(): Promise<HealthPayload | null> {
  try {
    const response = await fetch("/api/health", { signal: AbortSignal.timeout(8000), cache: "no-store" });
    return response.ok ? ((await response.json()) as HealthPayload) : null;
  } catch {
    return null;
  }
}

function moneyMoved(c: Case): string {
  const a = c.authorization?.action;
  if (c.action?.status === "ACCEPTED" && c.action.replayed !== true && a) return `${money(a.amountMinor, a.currency)} simulated`;
  return "$0.00";
}

export function JudgePage({ onRecord, onOpenCase }: { onRecord: (c: Case, scenario: DemoScenario) => void; onOpenCase: (id: string) => void }) {
  const [health, setHealth] = useState<HealthPayload | null | undefined>();
  const [slots, setSlots] = useState<Slot[]>(VERDICTS.map(() => ({ status: "idle" })));
  const [selected, setSelected] = useState(0);
  const [starting, setStarting] = useState(false);
  const inFlight = useRef(false);
  const running = starting || slots.some((s) => s.status === "running");

  // The runtime labels reuse the page's single /api/health response (already requested for the header chips),
  // so the button is ready as soon as that answer arrives. Running still re-reads health fresh first.
  useEffect(() => {
    let cancelled = false;
    loadHealth().then((h) => !cancelled && setHealth(h));
    return () => {
      cancelled = true;
    };
  }, []);

  const runAll = useCallback(async () => {
    // One run at a time: a second click during the fresh health check must not start a parallel run.
    if (inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    try {
      const h = await readHealth();
      setHealth(h);
      if (!canRunFixture(h)) return;
      setSlots(VERDICTS.map(() => ({ status: "idle" })));
      for (let i = 0; i < VERDICTS.length; i++) {
        const scenario = DEMO_SCENARIOS.find((d) => d.id === VERDICTS[i].scenarioId)!;
        setSlots((prev) => prev.map((s, j) => (j === i ? { status: "running" } : s)));
        try {
          const result = await submitCase(scenario.request);
          onRecord(result, scenario);
          setSlots((prev) => prev.map((s, j) => (j === i ? { status: "done", result } : s)));
        } catch (e) {
          const error = e instanceof ApiError ? `${e.message} (${e.status})` : e instanceof Error ? e.message : "Request failed";
          setSlots((prev) => prev.map((s, j) => (j === i ? { status: "error", error } : s)));
        }
      }
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }, [onRecord]);

  const fixtureOk = canRunFixture(health);
  const selectedSlot = slots[selected];

  // Judge Mode shows only the proof chain, so a step's panel lives in the full investigation:
  // open the case there, then scroll to the panel once it renders.
  const openStepInInvestigation = (caseId: string, anchor: string) => {
    onOpenCase(caseId);
    const until = Date.now() + 2000;
    const seek = () => {
      const el = document.getElementById(anchor);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      else if (Date.now() < until) requestAnimationFrame(seek);
    };
    requestAnimationFrame(seek);
  };

  return (
    <div className="judge motion-fade-in">
      <header className="judge-hero">
        <p className="judge-eyebrow">Judge Mode</p>
        <h2 className="judge-title">Verify JARVIS in two minutes.</h2>
        <p className="judge-lede">
          AI proposes. Policy decides. Every refund is verified. Run the core outcomes below against this demo's API, see which steps
          the model touched, then inspect the recorded AMD-hosted run from 14 Oct 2026.
        </p>
        <ul className="judge-chips" aria-label="Runtime labels">
          <li className={health === undefined ? "chip" : fixtureOk ? "chip chip-ok" : "chip chip-warn"}>
            {health === undefined ? "Checking runtime…" : fixtureOk ? "Fixture AI runtime" : health ? `Runtime: ${health.aiMode ?? "unknown"}` : "API not reachable"}
          </li>
          <li className="chip">Synthetic store data</li>
          <li className="chip">Payments simulated · no real money</li>
          <li className="chip chip-amd">AMD run: recorded, not live</li>
        </ul>
        <nav className="judge-jump" aria-label="Judge Mode sections">
          <a href="#judge-verdicts">1 · Four outcomes</a>
          <a href="#judge-authority">2 · Who decides</a>
          <a href="#judge-proof">3 · Inspect a case</a>
          <a href="#judge-amd">4 · Recorded AMD run</a>
          <a href="#judge-evidence">5 · Evidence files</a>
          <a href="#judge-impact">6 · Merchant impact</a>
        </nav>
      </header>

      <section id="judge-verdicts" aria-labelledby="judge-verdicts-title" className="judge-section">
        <div className="judge-section-head">
          <div>
            <h3 id="judge-verdicts-title">1 · One refund, one blocked demand, one prevented double refund, one contradicted amount</h3>
            <p>
              The button sends the four canonical requests to the demo API. Every run uses a fresh
              synthetic world.
            </p>
          </div>
          <button type="button" className={btn.primary} onClick={runAll} disabled={running || health === undefined || !fixtureOk}>
            {running ? "Running…" : slots.every((s) => s.status === "done") ? "Run again" : "Run all four"}
          </button>
        </div>
        {health !== undefined && !fixtureOk && (
          <p role="alert" className="judge-warn">
            The runtime did not report fixture AI with simulated payments, so Judge Mode will not send requests. Check AI provider for details.
          </p>
        )}
        <ol className="judge-verdicts">
          {VERDICTS.map((v, i) => {
            const slot = slots[i];
            const scenario = DEMO_SCENARIOS.find((d) => d.id === v.scenarioId)!;
            const outcome = slot.status === "done" ? missionOutcome(slot.result) : null;
            return (
              <li key={v.scenarioId} className={`verdict ${outcome ? `verdict-${outcome.tone}` : ""} ${selected === i ? "verdict-selected" : ""}`}>
                <p className="verdict-order">Order #{scenario.request.orderId}</p>
                <h4>{v.headline}</h4>
                {slot.status === "done" && (
                  <p className="verdict-money">
                    {moneyMoved(slot.result)}
                    <span>{slot.result.action?.status === "ACCEPTED" ? (slot.result.verification?.verified ? " · read-back verified" : " · not verified") : " · nothing executed"}</span>
                  </p>
                )}
                <blockquote className="verdict-quote">“{scenario.request.message}”</blockquote>
                <dl className="verdict-facts">
                  <div>
                    <dt>Expected</dt>
                    <dd>{v.expected}</dd>
                  </div>
                  <div>
                    <dt>Result</dt>
                    <dd aria-live="polite">
                      {slot.status === "idle" && <span className="muted">Not run yet</span>}
                      {slot.status === "running" && <span className="muted">Running…</span>}
                      {slot.status === "error" && <span className="danger">{slot.error}</span>}
                      {slot.status === "done" && <StateBadge state={slot.result.state} />}
                    </dd>
                  </div>
                  {slot.status === "done" && (
                    <>
                      <div>
                        <dt>Policy</dt>
                        <dd>{slot.result.authorization?.outcome ?? "not reached"}</dd>
                      </div>
                      <div>
                        <dt>Money moved</dt>
                        <dd>{moneyMoved(slot.result)}</dd>
                      </div>
                      <div>
                        <dt>Read-back</dt>
                        <dd>{slot.result.verification ? (slot.result.verification.verified ? "verified" : "mismatch") : "not executed"}</dd>
                      </div>
                    </>
                  )}
                </dl>
                {outcome && <p className="verdict-outcome">{outcome.title}. {outcome.detail}</p>}
                {slot.status === "done" && (
                  <div className="verdict-actions">
                    <button type="button" className={btn.secondary} aria-pressed={selected === i} onClick={() => setSelected(i)}>
                      Inspect why
                    </button>
                    <button type="button" className={btn.ghost} onClick={() => onOpenCase(slot.result.id)}>
                      Full investigation →
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <section id="judge-authority" aria-labelledby="judge-authority-title" className="judge-section">
        <h3 id="judge-authority-title">2 · Who decides at each step</h3>
        <p>The model touches two steps and has no authority in either. Code owns every step that can move money.</p>
        <ol className="authority">
          {AUTHORITY_STEPS.map((s, i) => (
            <li key={s.label} className={`authority-step authority-${s.who}`}>
              <span className="authority-index">{String(i + 1).padStart(2, "0")}</span>
              <span className="authority-who">{s.who === "ai" ? "AI · proposes only" : s.who === "code" ? "Deterministic code" : "Untrusted input"}</span>
              <strong>{s.label}</strong>
              <span className="authority-detail">{s.detail}</span>
            </li>
          ))}
        </ol>
        <div className="baseline">
          <h4>Remove the policy layer and replay the same proposals</h4>
          <p className="amd-note">{NO_POLICY_BASELINE.label}. 30 pinned adversarial cases, identical proposals in both columns.</p>
          <dl className="baseline-grid">
            <div className="baseline-jarvis">
              <dt>JARVIS</dt>
              <dd><strong>{NO_POLICY_BASELINE.jarvis.unsafe}</strong> unsafe outcomes</dd>
              <dd><strong>{NO_POLICY_BASELINE.jarvis.unsafeMoneyMovements}</strong> unauthorized refunds</dd>
            </div>
            <div className="baseline-bare">
              <dt>Same AI, no policy layer</dt>
              <dd><strong>{NO_POLICY_BASELINE.noPolicy.unsafe}</strong> unsafe outcomes</dd>
              <dd><strong>{NO_POLICY_BASELINE.noPolicy.unsafeMoneyMovements}</strong> unauthorized refunds</dd>
            </div>
          </dl>
          <p className="amd-note">
            No-policy refunds are computed from each case's evidence, never sent to a gateway. <a href={evidenceUrl(BASELINE_FILE)}>Result file</a> ·{" "}
            <a href={evidenceUrl("docs/improvement/BASELINE_EXPERIMENT.md")}>method and limits</a>
          </p>
          <StressLab />
        </div>
      </section>

      <section id="judge-proof" aria-labelledby="judge-proof-title" className="judge-section">
        <h3 id="judge-proof-title">3 · Inspect a case</h3>
        {selectedSlot.status === "done" ? (
          <div className="space-y-3">
            <p>
              Order #{selectedSlot.result.request.orderId} · case <code>{selectedSlot.result.id}</code> · {selectedSlot.result.audit.length} audit events. Everything below comes
              from the returned case record.
            </p>
            <DecisionExplainer caseData={selectedSlot.result} />
            <ProofChain caseData={selectedSlot.result} onOpenStep={(anchor) => openStepInInvestigation(selectedSlot.result.id, anchor)} />
          </div>
        ) : (
          <p className="judge-empty">Run the requests above, then choose “Inspect why” on any card to see its policy checks, evidence and audit chain.</p>
        )}
      </section>

      <LatestAmdRun />
      <RecordedAmdRun />

      <section id="judge-evidence" aria-labelledby="judge-evidence-title" className="judge-section">
        <h3 id="judge-evidence-title">5 · Evidence files</h3>
        <ul className="evidence-list">
          <li><a href={evidenceUrl(LATEST_EVIDENCE_FILES.demo)}>17 Oct live checks, four orders</a> <span>{LATEST_RUN.checksPassed}/{LATEST_RUN.checksTotal} checks, per-call adapter and latency</span></li>
          <li><a href={evidenceUrl(LATEST_EVIDENCE_FILES.gate)}>17 Oct startup gate</a> <span>model listed, both probes passed, key found in files: {LATEST_RUN.keyLeakFiles}</span></li>
          <li><a href={evidenceUrl(EVIDENCE_FILES.smoke)}>First AMD call (smoke test)</a> <span>HTTP 200, served model, rate-limit headers</span></li>
          <li><a href={evidenceUrl(EVIDENCE_FILES.gate)}>Startup gate</a> <span>model listed, both schema probes passed</span></li>
          <li><a href={evidenceUrl(EVIDENCE_FILES.demo)}>Live demo checks</a> <span>17/17 checks, per-call adapter and latency</span></li>
          <li><a href={evidenceUrl(EVIDENCE_FILES.bench)}>30-case benchmark, run tf-1</a> <span>every case, expected vs actual</span></li>
          <li><a href={evidenceUrl("evals/results/duplicate-charge-eval.v1.json")}>Fixture benchmark</a> <span>deterministic fixture model, the CI safety gate</span></li>
          <li><a href={evidenceUrl("docs/AMD_EVIDENCE.md")}>AMD evidence write-up</a> <span>method, caveats, reproduction</span></li>
        </ul>
      </section>

      <MerchantImpact />
    </div>
  );
}

function LatestAmdRun() {
  const r = LATEST_RUN;
  return (
    <section id="judge-amd-latest" aria-labelledby="judge-amd-latest-title" className="judge-section judge-amd">
      <p className="amd-label" role="note">{r.label}</p>
      <h3 id="judge-amd-latest-title">4 · All four requests on AMD-hosted inference, 17 Oct 2026</h3>
      <p>
        The owner ran the live gate on the four canonical orders with the AMD-hosted model. Every understanding and decision step used{" "}
        <code>vllm:{r.model}</code> (served as <code>{r.servedModel}</code>); policy made every money decision. Copied from committed evidence
        and checked against it by a test.
      </p>
      <dl className="amd-meta">
        <div><dt>Recorded</dt><dd>{new Date(r.capturedAt).toUTCString().replace("GMT", "UTC")}</dd></div>
        <div><dt>Startup probes</dt><dd>understanding {r.startup.probes.understanding} · decision {r.startup.probes.decision}</dd></div>
        <div><dt>Checks</dt><dd>{r.checksPassed}/{r.checksTotal} passed</dd></div>
        <div><dt>Key found in logs or results</dt><dd>{r.keyLeakFiles} files</dd></div>
      </dl>
      <div className="table-wrap">
        <table className="amd-table">
          <caption className="sr-only">Recorded outcomes of the four orders on the AMD-hosted model, 17 Oct 2026</caption>
          <thead>
            <tr><th scope="col">Order</th><th scope="col">Request</th><th scope="col">Final state</th><th scope="col">Policy</th><th scope="col">Read-back</th><th scope="col">Understanding</th><th scope="col">Decision</th></tr>
          </thead>
          <tbody>
            {r.cases.map((c) => (
              <tr key={c.orderId}>
                <th scope="row">#{c.orderId}</th>
                <td>{c.label}</td>
                <td><StateBadge state={c.state} /></td>
                <td>{c.policy}</td>
                <td>{c.verified === true ? "simulated refund verified" : "not executed"}</td>
                <td>{(c.latencies[0] / 1000).toFixed(1)} s</td>
                <td>{(c.latencies[1] / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="amd-note">The run used commit {r.gitHead.slice(0, 7)} with uncommitted cloud-backend files that the local refund path does not use. It is separate from the 14 Oct run below.</p>
    </section>
  );
}

function RecordedAmdRun() {
  const timeline = replayTimeline();
  const [shown, setShown] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const r = RECORDED_RUN;
  const b = r.bench;

  useEffect(() => () => window.clearInterval(timer.current), []);

  const replay = () => {
    window.clearInterval(timer.current);
    if (prefersReducedMotion()) {
      setShown(timeline.length);
      return;
    }
    setShown(0);
    timer.current = window.setInterval(() => {
      setShown((n) => {
        if (n + 1 >= timeline.length) window.clearInterval(timer.current);
        return Math.min(n + 1, timeline.length);
      });
    }, 550);
  };

  return (
    <section id="judge-amd" aria-labelledby="judge-amd-title" className="judge-section judge-amd">
      <p className="amd-label" role="note">{r.label}</p>
      <h3 id="judge-amd-title">4 · The same three requests on AMD-hosted inference, 14 Oct 2026</h3>
      <p>
        Copied from committed evidence files. A test keeps these values identical to the files, and nothing on this page calls a model.
      </p>
      <dl className="amd-meta">
        <div><dt>Run</dt><dd>startup gate, three demo orders, then the 30-case benchmark (run {r.bench.runId})</dd></div>
        <div><dt>Configuration</dt><dd>structured output <code>{r.structuredOutput}</code> · calls paced under the key's {r.smoke.rpmLimit} requests/min limit</dd></div>
        <div><dt>Model requested</dt><dd><code>{r.model}</code></dd></div>
        <div><dt>Model served</dt><dd><code>{r.servedModel}</code></dd></div>
        <div><dt>Endpoint</dt><dd><code>{r.endpointHost}</code></dd></div>
        <div><dt>Recorded</dt><dd>{new Date(r.demo.capturedAt).toUTCString().replace("GMT", "UTC")}</dd></div>
        <div><dt>Startup probes</dt><dd>understanding {r.startup.probes.understanding} · decision {r.startup.probes.decision}</dd></div>
        <div><dt>Demo checks</dt><dd>{r.demo.checksPassed}/{r.demo.checksTotal} passed</dd></div>
      </dl>
      <p className="amd-note">{r.endpointNote}</p>

      <div className="table-wrap">
        <table className="amd-table">
          <caption className="sr-only">Recorded outcomes of the three demo orders on the AMD-hosted model</caption>
          <thead>
            <tr><th scope="col">Order</th><th scope="col">Final state</th><th scope="col">Policy</th><th scope="col">Execution</th><th scope="col">Read-back</th><th scope="col">Understanding</th><th scope="col">Decision</th></tr>
          </thead>
          <tbody>
            {r.demo.cases.map((c) => (
              <tr key={c.orderId}>
                <th scope="row">#{c.orderId}</th>
                <td><StateBadge state={c.state} /></td>
                <td>{c.policy}</td>
                <td>{c.execution === "ACCEPTED" ? "simulated refund accepted" : "none"}</td>
                <td>{c.verified === true ? "verified" : "not executed"}</td>
                <td>{(c.aiCalls[0].latencyMs / 1000).toFixed(1)} s</td>
                <td>{(c.aiCalls[1].latencyMs / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="amd-checks">
        <summary>All {r.demo.checksTotal} recorded checks, including audit and gateway evidence</summary>
        <ol>
          {r.demo.checks.map(([name, detail]) => (
            <li key={name}>
              <span aria-hidden className="amd-check-mark">✓</span>
              <span>{name.replace(/^\d+ /, "")}</span>
              <span className="mono">{detail}</span>
            </li>
          ))}
        </ol>
        <p className="amd-note">The run did not store full model outputs or audit records; these checks are what the verifier recorded about them.</p>
      </details>

      <div className="amd-replay">
        <button type="button" className={btn.secondary} onClick={replay}>
          {shown ? "Replay recorded calls again" : "Replay recorded calls"}
        </button>
        <ol aria-live="polite" className="amd-timeline">
          {timeline.slice(0, shown).map((e) => (
            <li key={e.at}>
              <span className="mono">+{(e.offsetMs / 1000).toFixed(1)} s</span>
              <span>#{e.orderId} · {e.stage}</span>
              <span className="mono">{e.adapter}</span>
              <span className="mono">{(e.latencyMs / 1000).toFixed(1)} s</span>
            </li>
          ))}
        </ol>
        <p className="amd-note">Offsets and latencies are the recorded values from the 14 Oct run, replayed for reading. They are not measured now.</p>
      </div>

      <h4 className="amd-subhead">Pinned 30-case benchmark on the same endpoint (run {b.runId})</h4>
      <dl className="amd-metrics">
        <div><dt>Unsafe autonomous actions</dt><dd>{b.unsafeAutonomousActions}</dd></div>
        <div><dt>Required escalations made</dt><dd>{b.correctEscalations}/{b.groundTruthEscalation}</dd></div>
        <div><dt>Exact expected outcome</dt><dd>{b.passed}/{b.totalCases}</dd></div>
        <div><dt>Autonomous cases resolved</dt><dd>{b.correctAutonomousResolutions}/{b.groundTruthAutonomous}</dd></div>
        <div><dt>Median latency</dt><dd>{(b.latencyMs.UNDERSTANDING.p50 / 1000).toFixed(1)} s + {(b.latencyMs.MODEL.p50 / 1000).toFixed(1)} s</dd></div>
        <div><dt>p95 latency</dt><dd>{(b.latencyMs.UNDERSTANDING.p95 / 1000).toFixed(1)} s + {(b.latencyMs.MODEL.p95 / 1000).toFixed(1)} s</dd></div>
      </dl>
      <ul className="amd-caveats">
        <li>Synthetic, deliberately adversarial cases: 20 of 30 must go to a person. Not production traffic.</li>
        <li>{b.scriptedModelCases.join(" and ")} use scripted decision output, so they are not model measurements.</li>
        <li>
          The {b.missedCases.length} misses all erred toward safety, with no money moved:{" "}
          {b.missedCases.map((m) => `${m.id} expected ${m.expected}, ended ${m.actual} (${m.reasons.join(", ").toLowerCase().replaceAll("_", " ")})`).join("; ")}.
        </li>
        <li>The run used a working tree with uncommitted changes on top of commit {r.gitHead.slice(0, 7)}.</li>
      </ul>
    </section>
  );
}
