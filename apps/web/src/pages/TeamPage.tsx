import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, agentById, type AgentId } from "../team/agents.ts";
import { scopedContext } from "../team/context.ts";
import { DATASET_META, MONTHS } from "../team/dataset.ts";
import { computeMetrics, formatMetricValue } from "../team/metrics.ts";
import { append, deleteThread, exportThread, loadStore, MAX_MESSAGE_CHARS, saveStore, setShared, sharedNotes, thread, type TeamStore } from "../team/conversations.ts";
import { runBoardroom, type Analysis, type AuditEvent, type BoardroomResult } from "../team/orchestrator.ts";
import { FixtureTeamProvider } from "../team/provider.ts";
import { LiveTeamError, liveBoardroom, liveReply, liveStatus, provenanceLabel, type LiveUsage } from "../team/live-client.ts";
import { submitCase, ApiError } from "../lib/api.ts";
import type { Case } from "../lib/case-types.ts";
import { DEMO_SCENARIOS, type DemoScenario } from "../fixtures/demo-scenarios.ts";
import { caseProvenance, isActionable, MISSION_LINK_NOTE } from "../team/mission.ts";
import "./team.css";

type Tab = "directory" | "chat" | "boardroom";
const DEMO_PROBLEM =
  "Our quality is falling, monthly sales are declining and our margins are shrinking. Investigate the causes and help us improve business performance.";
// Paced so each specialist's turn is visible; this is not model latency.
const provider = new FixtureTeamProvider(220);
/** Provider mode for this page. The operator token lives only in page memory. */
interface LiveMode {
  mode: "fixture" | "live";
  token: string;
  model: string | null;
  usage: LiveUsage | null;
}
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

type MissionHooks = { onRecord?: (c: Case, scenario: DemoScenario) => void; onOpenCase?: (id: string) => void };

export function TeamPage({ onRecord, onOpenCase }: MissionHooks = {}) {
  const [tab, setTab] = useState<Tab>("directory");
  const [agent, setAgent] = useState<AgentId>("cfo");
  const [store, setStore] = useState<TeamStore>(() => loadStore());
  const [live, setLive] = useState<LiveMode>({ mode: "fixture", token: "", model: null, usage: null });
  const [liveMsg, setLiveMsg] = useState("");
  const connect = async () => {
    setLiveMsg("Checking the server…");
    try {
      const s = await liveStatus(live.token);
      setLive((l) => ({ ...l, mode: "live", model: s.provider.model, usage: s.usage }));
      setLiveMsg(`Live team ready: ${s.provider.model}. ${s.usage.maxRequests !== undefined ? `${s.usage.remainingRequests} of ${s.usage.maxRequests} requests left${s.usage.freeOnly ? " (free models only)" : ""}` : `Spent ${s.usage.spentUsd.toFixed(4)} of ${s.usage.capUsd}`} in this server process.${s.usage.stopped ? ` Stopped: ${s.usage.stopped}.` : ""}`);
    } catch (e) {
      setLive((l) => ({ ...l, mode: "fixture", model: null }));
      setLiveMsg(e instanceof LiveTeamError ? e.message : "The JARVIS server did not answer.");
    }
  };
  useEffect(() => {
    saveStore(store);
  }, [store]);
  const open = (id: AgentId) => {
    setAgent(id);
    setTab("chat");
  };

  return (
    <div className="team motion-fade-in">
      <header className="team-hero">
        <p className="team-eyebrow">JARVIS · AI Executive Team · prototype</p>
        <h2 className="team-title">Six specialists, one accountable plan.</h2>
        <p className="team-lede">
          Ask a specialist privately, or bring a business problem to the boardroom. Specialists propose; every action waits for your approval and nothing is executed.
        </p>
        <ul className="team-chips" aria-label="Runtime labels">
          {live.mode === "live" ? (
            <li className="chip chip-live">OpenRouter live inference · {live.model} · operator session</li>
          ) : (
            <li className="chip chip-warn">Fixture specialists: deterministic rules, no language model</li>
          )}
          <li className="chip">{DATASET_META.label}</li>
          <li className="chip">Single local user · stored in this browser only</li>
        </ul>
      </header>

      <details className="team-provider">
        <summary>Provider: {live.mode === "live" ? `OpenRouter (live) · ${live.model}` : "fixture rules in this browser"}</summary>
        <p className="muted">
          Live mode sends requests to the local JARVIS server, which holds the OpenRouter key and enforces the model allowlist, the spend cap and one request at a time. It
          needs the server operator token, which is kept in this page's memory only.
        </p>
        <div className="team-actions">
          <label className="team-select">
            Operator token
            <input type="password" autoComplete="off" value={live.token} onChange={(e) => setLive((l) => ({ ...l, token: e.target.value }))} />
          </label>
          <button type="button" className="team-btn" onClick={() => void connect()} disabled={!live.token}>
            Use live team
          </button>
          {live.mode === "live" && (
            <button type="button" className="team-link" onClick={() => (setLive((l) => ({ ...l, mode: "fixture", model: null })), setLiveMsg("Back to fixture rules."))}>
              Back to fixture
            </button>
          )}
        </div>
        {liveMsg && <p role="status" className="muted">{liveMsg}</p>}
      </details>

      <div className="team-tabs" role="tablist" aria-label="AI Team">
        {(
          [
            ["directory", "Executive directory"],
            ["chat", "Private chats"],
            ["boardroom", "Executive boardroom"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`team-tab-${id}`} aria-controls={`team-panel-${id}`} aria-selected={tab === id} className={tab === id ? "team-tab team-tab-on" : "team-tab"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      <section role="tabpanel" id={`team-panel-${tab}`} aria-labelledby={`team-tab-${tab}`} className="team-panel">
        {tab === "directory" && <Directory onOpen={open} store={store} />}
        {tab === "chat" && <PrivateChat agent={agent} setAgent={setAgent} store={store} setStore={setStore} live={live} />}
        {tab === "boardroom" && <Boardroom store={store} live={live} onRecord={onRecord} onOpenCase={onOpenCase} />}
      </section>
    </div>
  );
}

function Directory({ onOpen, store }: { onOpen: (id: AgentId) => void; store: TeamStore }) {
  return (
    <ul className="team-directory">
      {AGENTS.map((a) => (
        <li key={a.id} className={`team-card team-${a.id}`}>
          <div className="team-card-head">
            <span className="team-avatar" aria-hidden="true">{a.short}</span>
            <div>
              <h3>{a.title}</h3>
              <p className="muted mono">{a.version} · AI specialist (fixture)</p>
            </div>
          </div>
          <ul className="team-resp">
            {a.responsibilities.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="team-boundary">{a.boundary}</p>
          <p className="muted">
            Sees {a.metrics.length} metrics · tools: {a.tools.join(", ")} · {thread(store, a.id).length} private messages
          </p>
          <button type="button" className="team-btn" onClick={() => onOpen(a.id)}>
            Open private chat with {a.short}
          </button>
        </li>
      ))}
    </ul>
  );
}

function PrivateChat({ agent, setAgent, store, setStore, live }: { agent: AgentId; setAgent: (a: AgentId) => void; store: TeamStore; setStore: (f: (s: TeamStore) => TeamStore) => void; live: LiveMode }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const role = agentById(agent);
  const msgs = thread(store, agent);
  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [msgs.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    setStore((s) => append(s, agent, { author: "owner", authorKind: "human", text, at: new Date().toISOString() }));
    try {
      const r = live.mode === "live" ? await liveReply(live.token, agent, text) : await provider.reply(agent, text, scopedContext(agent), new AbortController().signal);
      setStore((s) => append(s, agent, { author: agent, authorKind: r.provider.kind === "live" ? "ai-live" : "ai-fixture", text: r.text, evidence: r.evidence, at: new Date().toISOString(), provenance: provenanceLabel(r.provider) }));
    } catch (e) {
      setStore((s) => append(s, agent, { author: agent, authorKind: "ai-fixture", text: `No answer: ${e instanceof Error ? e.message : "request failed"}`, at: new Date().toISOString(), provenance: "error" }));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([exportThread(store, agent)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `jarvis-team-${agent}-chat.json` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="team-chat">
      <label className="team-select">
        Specialist
        <select value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>
          {AGENTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        Private to you and {role.short}. Nothing here reaches the boardroom unless you press “Share to boardroom” on a message. {role.short} sees only:{" "}
        {role.metrics.length} metrics from the synthetic store.
      </p>
      <ol className="team-log" role="log" aria-live="polite" aria-label={`Private chat with ${role.title}`} ref={logRef}>
        {msgs.length === 0 && <li className="team-empty">No messages yet. Try “Why is our margin falling?”</li>}
        {msgs.map((m) => (
          <li key={m.id} className={m.authorKind === "human" ? "msg msg-human" : "msg msg-ai"}>
            <p className="msg-meta">
              <strong>{m.authorKind === "human" ? "You (human)" : m.authorKind === "ai-live" ? `${role.short} (AI specialist, live)` : `${role.short} (AI specialist, fixture)`}</strong>
              {m.provenance && m.authorKind !== "human" && <span className="muted mono">{m.provenance}</span>} · {time(m.at)} · #{m.seq}
              {m.sharedToBoardroom && <span className="st st-ok">shared to boardroom</span>}
            </p>
            <p className="msg-text">{m.text}</p>
            {m.evidence && m.evidence.length > 0 && <p className="muted mono">evidence: {m.evidence.join(", ")}</p>}
            <button type="button" className="team-link" onClick={() => setStore((s) => setShared(s, agent, m.id, !m.sharedToBoardroom))}>
              {m.sharedToBoardroom ? "Stop sharing" : "Share to boardroom"}
            </button>
          </li>
        ))}
      </ol>
      <form
        className="team-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="team-draft" className="sr-only">
          Message to {role.title}
        </label>
        <textarea id="team-draft" value={draft} maxLength={MAX_MESSAGE_CHARS} rows={2} placeholder={`Ask ${role.short} about their area…`} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), void send())} />
        <button type="submit" className="team-btn" disabled={busy || !draft.trim()}>
          {busy ? "Answering…" : "Send"}
        </button>
      </form>
      <div className="team-actions">
        <button type="button" className="team-link" onClick={download} disabled={msgs.length === 0}>
          Export this chat (JSON)
        </button>
        <button type="button" className="team-link danger" onClick={() => window.confirm(`Delete your private chat with ${role.short}? This cannot be undone.`) && setStore((s) => deleteThread(s, agent))} disabled={msgs.length === 0}>
          Delete this chat
        </button>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<Analysis["status"], string> = { ok: "done", invalid: "rejected: invalid output", timeout: "timed out", error: "failed", cancelled: "cancelled", skipped_budget: "skipped: budget" };

function Boardroom({ store, live, onRecord, onOpenCase }: { store: TeamStore; live: LiveMode } & MissionHooks) {
  const [missionFor, setMissionFor] = useState<string | null>(null);
  const [problem, setProblem] = useState(DEMO_PROBLEM);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Analysis[]>([]);
  const [result, setResult] = useState<BoardroomResult | null>(null);
  const [error, setError] = useState("");
  const [decisions, setDecisions] = useState<Record<string, "approved" | "rejected">>({});
  const [ownerAudit, setOwnerAudit] = useState<AuditEvent[]>([]);
  const ctrl = useRef<AbortController | null>(null);
  const shared = sharedNotes(store);
  const metrics = useMemo(() => computeMetrics(), []);

  const convene = async () => {
    if (running) return;
    setRunning(true);
    setProgress([]);
    setResult(null);
    setError("");
    setDecisions({});
    setOwnerAudit([]);
    ctrl.current = new AbortController();
    try {
      const r =
        live.mode === "live"
          ? await liveBoardroom(live.token, problem, shared, ctrl.current.signal)
          : await runBoardroom(problem, provider, { signal: ctrl.current.signal, shared, onProgress: (a) => setProgress((p) => [...p, a]) });
      if (live.mode === "live") setProgress(r.analyses);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error && e.name !== "AbortError" ? e.message : "The run was cancelled.");
    } finally {
      setRunning(false);
    }
  };

  const decide = (id: string, d: "approved" | "rejected") => {
    setDecisions((x) => ({ ...x, [id]: d }));
    const base = result?.audit.length ?? 0;
    setOwnerAudit((a) => [...a, { seq: base + a.length + 1, at: new Date().toISOString(), type: d === "approved" ? "OWNER_APPROVED" : "OWNER_REJECTED", detail: `${id}: recorded as a decision for follow-up; JARVIS executed nothing` }]);
  };

  return (
    <div className="team-board">
      <div className="team-participants" aria-label="Participants">
        <span className="chip chip-human">You · human · local owner</span>
        {AGENTS.map((a) => (
          <span key={a.id} className="chip">
            {a.short} · AI (fixture)
          </span>
        ))}
      </div>
      <label className="team-problem">
        Business problem for the team
        <textarea value={problem} rows={3} maxLength={2000} onChange={(e) => setProblem(e.target.value)} />
      </label>
      <p className="muted">
        {shared.length > 0 ? `${shared.length} message(s) you shared from private chats will be given to the specialists.` : "No private-chat messages are shared. Specialists see only their scoped metrics."} Limits per request: 5
        specialists + CEO, 6 calls, 15 s per call, structured output only.
      </p>
      <div className="team-actions">
        <button type="button" className="team-btn" onClick={() => void convene()} disabled={running || !problem.trim()}>
          {running ? "The team is analysing…" : "Convene the team"}
        </button>
        {running && (
          <button type="button" className="team-link" onClick={() => ctrl.current?.abort()}>
            Cancel
          </button>
        )}
      </div>

      {(running || progress.length > 0) && (
        <ol className="team-progress" aria-live="polite" aria-label="Specialist progress">
          {progress.map((a) => (
            <li key={a.agent}>
              <strong>{agentById(a.agent).short}</strong> {STATUS_LABEL[a.status]} {a.status === "ok" && `· ${a.output!.findings.length} findings · ${a.output!.recommendations.length} proposals`}
            </li>
          ))}
          {running && <li className="muted">Next specialist analysing…</li>}
        </ol>
      )}

      {error && <p role="alert" className="team-empty">{error}</p>}
      {result && (
        <article className="team-report" aria-label="Executive report">
          <h3>Executive report</h3>
          <p className="muted">
            {result.cancelled ? "Cancelled by you; partial report. " : ""}Request routed to {result.selected.map((a) => agentById(a).short).join(", ")} · {result.calls} specialist calls · <strong>{provenanceLabel(result.provider)}</strong> ({result.provider.name})
          </p>

          <h4>Executive diagnosis: what the records establish</h4>
          <ul>
            {result.report.diagnosis.map((d, i) => (
              <li key={i}>
                <span className="team-from">{agentById(d.from).short}</span>
                {d.alsoFrom.map((x) => (
                  <span key={x} className="team-from">
                    {agentById(x).short}
                  </span>
                ))}{" "}
                {d.text} <span className="muted mono">[{d.evidence.join(", ")}]</span>
              </li>
            ))}
          </ul>

          <h4>Key hypotheses: not yet established</h4>
          <ul>
            {result.report.hypotheses.map((d, i) => (
              <li key={i}>
                <span className="team-from">{agentById(d.from).short}</span> {d.text}
              </li>
            ))}
          </ul>

          {result.conflicts.length > 0 && (
            <>
              <h4>Disagreements</h4>
              {result.conflicts.map((c) => (
                <div key={c.lever} className="team-conflict">
                  <p>
                    <strong>{c.lever}</strong>
                  </p>
                  <ul>
                    {c.positions.map((p) => (
                      <li key={p.recommendationId}>
                        <span className="team-from">{agentById(p.agent).short}</span> {p.direction}: {p.action}
                      </li>
                    ))}
                  </ul>
                  <p>{c.resolution}</p>
                </div>
              ))}
            </>
          )}

          <h4>Recommended actions (each needs your approval; nothing is executed)</h4>
          <ol className="team-plan">
            {result.report.actions.map((a) => (
              <li key={a.id} className={decisions[a.id] ? `team-plan-${decisions[a.id]}` : ""}>
                <p>
                  {a.action} {a.note && <span className="st st-review">{a.note}</span>}
                </p>
                <p className="muted">
                  Owner: {agentById(a.owner).short} · proposed by {agentById(a.proposedBy).short} · success metric: {a.successMetric}
                </p>
                <div className="team-actions">
                  <button type="button" className="team-link" aria-pressed={decisions[a.id] === "approved"} onClick={() => decide(a.id, "approved")}>
                    Approve for follow-up
                  </button>
                  <button type="button" className="team-link" aria-pressed={decisions[a.id] === "rejected"} onClick={() => decide(a.id, "rejected")}>
                    Reject
                  </button>
                  {decisions[a.id] && <span className={decisions[a.id] === "approved" ? "st st-ok" : "st st-fail"}>{decisions[a.id]} by you</span>}
                  {isActionable(a) && (
                    <button type="button" className="team-link" aria-expanded={missionFor === a.id} onClick={() => setMissionFor(missionFor === a.id ? null : a.id)}>
                      Hand to JARVIS: open a refund investigation
                    </button>
                  )}
                </div>
                {missionFor === a.id && <MissionPanel actionId={a.id} onRecord={onRecord} onOpenCase={onOpenCase} />}
              </li>
            ))}
          </ol>

          <h4>Expected impact (estimates with stated assumptions)</h4>
          <ul>
            {result.report.expectedImpact.map((e, i) => (
              <li key={i}>
                {e.text} <span className="muted">Assumption: {e.assumption}</span>
              </li>
            ))}
          </ul>

          <h4>Risks</h4>
          <ul>
            {result.report.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>

          <h4>30-day plan</h4>
          <ol>
            {result.report.plan30.map((p) => (
              <li key={p.window}>
                <strong>{p.window}</strong> · {agentById(p.owner).short}: {p.milestone}
              </li>
            ))}
          </ol>

          <h4>Human decisions required</h4>
          <ul>
            {result.report.humanDecisions.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>

          {result.report.sharedConsidered.length > 0 && (
            <>
              <h4>Shared from your private chats</h4>
              <ul>
                {result.report.sharedConsidered.map((n) => (
                  <li key={n.messageId}>
                    <span className="team-from">{agentById(n.from).short}</span> {n.text.split("\n")[0]} <span className="muted mono">[{n.messageId}]</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4>Missing information the team asked for</h4>
          <p>{result.report.missingInformation.join(" · ")}</p>

          <details className="team-evidence">
            <summary>Evidence: the synthetic records and calculations</summary>
            <table>
              <caption className="sr-only">Metrics by month, computed deterministically</caption>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  {MONTHS.map((m) => (
                    <th key={m.id} scope="col">
                      {m.id}
                    </th>
                  ))}
                  <th scope="col">Formula</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(metrics).map((m) => (
                  <tr key={m.key}>
                    <th scope="row">
                      {m.label} <span className="muted mono">({m.key})</span>
                    </th>
                    {m.series.map((v, i) => (
                      <td key={i}>{formatMetricValue(m.unit, v)}</td>
                    ))}
                    <td className="muted">{m.formula}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <details className="team-evidence">
            <summary>Audit trail ({result.audit.length + ownerAudit.length} events)</summary>
            <ol className="mono">
              {[...result.audit, ...ownerAudit].map((e) => (
                <li key={e.seq}>
                  #{e.seq} {e.type} {e.agent ? `[${e.agent}] ` : ""}
                  {e.detail}
                </li>
              ))}
            </ol>
          </details>
        </article>
      )}
    </div>
  );
}

type MissionState = { status: "idle" } | { status: "running" } | { status: "done"; c: Case } | { status: "error"; error: string };

/** Human-reviewed hand-off from a team recommendation to the real JARVIS case engine. */
function MissionPanel({ actionId, onRecord, onOpenCase }: { actionId: string } & MissionHooks) {
  const [m, setM] = useState<MissionState>({ status: "idle" });
  const scenario = DEMO_SCENARIOS.find((d) => d.id === "valid-duplicate")!;
  const run = async () => {
    if (m.status === "running") return;
    setM({ status: "running" });
    try {
      const c = await submitCase(scenario.request);
      onRecord?.(c, scenario);
      setM({ status: "done", c });
    } catch (e) {
      setM({ status: "error", error: e instanceof ApiError ? `${e.message} (${e.status})` : e instanceof Error ? e.message : "Request failed" });
    }
  };
  const verified = (c: Case) => c.state === "RESOLVED" && c.verification?.verified === true;
  return (
    <section className="team-mission" aria-label={`JARVIS investigation for ${actionId}`}>
      <p>
        <strong>Human review.</strong> Send the canonical synthetic request “{scenario.request.message}” (order #{scenario.request.orderId}) to JARVIS. The team cannot run it, choose the amount or
        approve a refund: JARVIS's model reads the request and proposes, deterministic policy decides, the simulated gateway executes only if authorized, and read-back verifies.
      </p>
      <p className="muted">{MISSION_LINK_NOTE}</p>
      <button type="button" className="team-btn" onClick={() => void run()} disabled={m.status === "running"}>
        {m.status === "running" ? "JARVIS is investigating…" : m.status === "done" ? "Run it again" : "Run JARVIS investigation"}
      </button>
      {m.status === "error" && <p role="alert" className="danger">{m.error}</p>}
      {m.status === "done" && (
        <dl className="team-mission-result">
          <div><dt>Result</dt><dd>{m.c.state}{verified(m.c) ? " · read-back verified" : ""}</dd></div>
          <div><dt>Policy</dt><dd>{m.c.authorization?.outcome ?? "not reached"}</dd></div>
          <div><dt>Money moved</dt><dd>{m.c.action?.status === "ACCEPTED" && m.c.authorization?.action ? `${(m.c.authorization.action.amountMinor / 100).toFixed(2)} ${m.c.authorization.action.currency} (simulated)` : "0.00 (nothing executed)"}</dd></div>
          <div><dt>Inference</dt><dd>{caseProvenance(m.c).label}</dd></div>
          <div><dt>Case</dt><dd className="mono">{m.c.id} · {m.c.audit.length} audit events</dd></div>
          {onOpenCase && (
            <div>
              <dt>Proof</dt>
              <dd>
                <button type="button" className="team-link" onClick={() => onOpenCase(m.c.id)}>
                  Open the full investigation and audit trail
                </button>
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
