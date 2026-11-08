// Read-only view of a finished run, built only from its sealed evidence bundle and the run registry.
// Nothing here can change a run, grant authority or talk to a model. Fields a bundle never recorded stay null and
// are listed in `notRetained`, so an older run is shown as it is rather than filled in.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { classifyEvidence, type EvidenceStatus } from "./evidence.ts";
import { findScenarioForRun, type Scenario } from "./scenarios.ts";

export type OutcomeClass =
  | "verified_success"
  | "designed_negative"
  | "verified_fail"
  | "order_not_approved"
  | "unexpected_failure"
  | "unexpected_result"
  | "timed_out"
  | "cancelled"
  | "incomplete_evidence"
  | "evidence_integrity_failure";

export interface OutcomeInput {
  status: string | null;
  verdict: string | null;
  outcomes: Record<string, string> | null;
  evidenceStatus: EvidenceStatus;
  expected: Scenario["expected"] | null;
}

/** Outcomes that must hold even in a designed negative test. A breach here is never "as designed". */
const SAFETY_OUTCOMES = ["permissions", "containment", "cleanup"];

/**
 * One label for one finished run. The order matters: evidence that fails its check overrides everything, and a
 * mission's designed failure counts only when it failed in the designed way, with every safety outcome intact.
 */
export function classifyOutcome(i: OutcomeInput): OutcomeClass {
  if (i.evidenceStatus === "TAMPERED") return "evidence_integrity_failure";
  if (i.status === "cancelled") return "cancelled";
  if (i.status === "failed" || i.status === null) return i.status === null ? "incomplete_evidence" : "unexpected_failure";
  if (i.evidenceStatus === "INCOMPLETE") return "incomplete_evidence";
  const safe = SAFETY_OUTCOMES.every((k) => i.outcomes?.[k] === "PASS");
  if (i.status === "timed_out") {
    return i.expected?.status === "timed_out" && i.verdict === "FAIL" && safe ? "designed_negative" : "timed_out";
  }
  if (i.expected?.verdict === "OPEN" && i.status === "completed") {
    // A person's task has no designed result: it either matched or it didn't, with the safety checks holding.
    if (i.verdict === "PASS") return "verified_success";
    const failing = Object.entries(i.outcomes ?? {}).filter(([, v]) => v === "FAIL").map(([k]) => k);
    if (i.verdict === "FAIL" && safe && failing.length === 1 && (failing[0] === "commerce" || failing[0] === "task")) return "verified_fail";
    if (i.verdict === "FAIL") return "unexpected_failure";
    return "incomplete_evidence";
  }
  if (i.verdict === "PASS") return !i.expected || i.expected.verdict === "PASS" ? "verified_success" : "unexpected_result";
  if (i.verdict === "FAIL") {
    const failing = Object.entries(i.outcomes ?? {}).filter(([, v]) => v === "FAIL").map(([k]) => k);
    const designed = i.expected?.verdict === "FAIL" && safe && failing.length > 0 && failing.every((k) => i.expected?.failing?.includes(k));
    return designed ? "designed_negative" : "unexpected_failure";
  }
  return "incomplete_evidence";
}

export type MissionOutcome = "PASS" | "DESIGNED FAIL" | "FAIL" | "TIMED OUT" | "CANCELLED" | "INCOMPLETE" | "NOT RELIABLE";
export type IntegrityStatus = "ANCHOR VERIFIED" | "INCOMPLETE" | "TAMPERED";

/** What the mission did. Says nothing about whether its evidence is intact. */
export function missionOutcomeOf(c: OutcomeClass): MissionOutcome {
  return ({ verified_success: "PASS", designed_negative: "DESIGNED FAIL", verified_fail: "FAIL", order_not_approved: "INCOMPLETE", unexpected_failure: "FAIL", unexpected_result: "FAIL", timed_out: "TIMED OUT", cancelled: "CANCELLED", incomplete_evidence: "INCOMPLETE", evidence_integrity_failure: "NOT RELIABLE" } as const)[c];
}

/** Whether the files match their checksums and recorded hash. Says nothing about whether the mission succeeded. */
export function integrityOf(evidenceStatus: EvidenceStatus, anchored: boolean): IntegrityStatus {
  if (evidenceStatus === "TAMPERED") return "TAMPERED";
  if (evidenceStatus === "INCOMPLETE" || !anchored) return "INCOMPLETE";
  return "ANCHOR VERIFIED";
}

export interface SummaryStep {
  step: number;
  tool: string | null;
  proposal: string;
  reason: string | null;
  decision: string;
  rule: string | null;
  dispatched: boolean;
  result: string | null;
}

export interface RunSummary {
  runId: string;
  source: "registry" | "archive";
  mission: { id: string; title: string; purpose: string; expected: Scenario["expected"] } | null;
  task: string | null;
  /** What the person typed, for a Live Task. Untrusted text. */
  userText: string | null;
  status: string | null;
  verdict: string | null;
  outcomeClass: OutcomeClass;
  missionOutcome: MissionOutcome;
  error: string | null;
  tier: string | null;
  codeSha: string | null;
  deployment: string | null;
  mode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  outcomes: Record<string, string> | null;
  checks: { name: string; outcome: string; expected?: unknown; observed?: unknown; detail?: string }[];
  expected: { subtotalCents?: number; discountCents?: number; totalCents?: number; ordersExpected?: number; requireCheckoutReached?: boolean } | null;
  observed: { totals: { subtotalCents?: number; discountCents?: number; totalCents?: number } | null; coupon: string | null; orders: number | null; checkoutReached: boolean | null } | null;
  model: { provider: string | null; requested: string | null; responseModels: string[]; calls: number | null; totalTokens: number | null; latencyMs: number | null } | null;
  steps: SummaryStep[];
  containment: { kind: "network" | "policy" | "limit"; text: string; detail: string | null }[];
  approval: { requested: boolean; cart: unknown; payloadSha256: string | null; granted: boolean; refused: boolean; replayStatus: number | null; replayRefused: boolean | null } | null;
  screenshots: string[];
  evidence: { status: EvidenceStatus; integrity_status: IntegrityStatus; reasons: string[]; integrity: string; files: number; manifestSha256: string | null; anchored: boolean; available: string[] };
  notRetained: string[];
}

const MAX_FILE_BYTES = 4_000_000;
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);

function readText(dir: string, rel: string): string | null {
  const p = join(dir, rel);
  try {
    if (!existsSync(p) || statSync(p).size > MAX_FILE_BYTES) return null;
    return readFileSync(p, "utf8");
  } catch { return null; }
}
function readJson<T>(dir: string, rel: string): T | null {
  const t = readText(dir, rel);
  if (t === null) return null;
  try { return JSON.parse(t) as T; } catch { return null; }
}
function readLines<T>(dir: string, rel: string): T[] | null {
  const t = readText(dir, rel);
  if (t === null) return null;
  const out: T[] = [];
  for (const line of t.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* a damaged line is the integrity check's business */ }
  }
  return out;
}

function describeProposal(p: unknown): { tool: string | null; text: string; reason: string | null } {
  if (!p || typeof p !== "object") return { tool: null, text: "unusable model reply", reason: null };
  const a = p as Record<string, unknown>;
  const tool = typeof a.tool === "string" ? a.tool.slice(0, 40) : null;
  const target = tool === "navigate" ? String(a.path ?? "") : tool === "fill" ? `${String(a.ref ?? "")} = "${String(a.value ?? "")}"` : tool === "finish" ? String(a.note ?? "") : String(a.ref ?? "");
  return { tool, text: `${tool ?? "unknown"}${target ? ` ${target}` : ""}`.slice(0, 200), reason: clip(a.reason, 300) };
}

export interface RegistryFacts { status: string; verdict: string | null; error: string | null; tier: string; mode: string; createdAt: string; updatedAt: string }

/**
 * Builds the summary. `anchor` is the separately recorded manifest hash: a string to compare against, null when the
 * registry should have one and has none, undefined when no anchor was ever recorded (older archived bundles).
 */
export function readRunSummary(opts: { runId: string; dir: string | null; anchor?: string | null; source: "registry" | "archive"; registry?: RegistryFacts }): RunSummary {
  const { runId, dir, anchor, source, registry } = opts;
  const notRetained: string[] = [];
  const classified = dir && existsSync(dir)
    ? classifyEvidence(dir, anchor)
    : { status: "INCOMPLETE" as EvidenceStatus, reasons: ["no evidence bundle was recorded for this run"], integrity: "nothing to check", files: 0, runId: null, runStatus: null };
  let evidenceStatus = classified.status;
  const reasons = [...classified.reasons];

  const bundle = dir && existsSync(dir) ? dir : null;
  const manifest = bundle ? readJson<Record<string, any>>(bundle, "manifest.json") : null;
  const assertions = bundle ? readJson<Record<string, any>>(bundle, "assertions.json") : null;
  const spec = bundle ? readJson<Record<string, any>>(bundle, "spec.json") : null;
  const server = bundle ? readJson<Record<string, any>>(bundle, "server-state.json") : null;
  const decisions = bundle ? readLines<Record<string, any>>(bundle, "policy-decisions.jsonl") : null;
  const calls = bundle ? readLines<Record<string, any>>(bundle, "model-calls.jsonl") : null;
  const gateway = bundle ? readLines<Record<string, any>>(bundle, "gateway.jsonl") : null;
  const events = bundle ? readLines<Record<string, any>>(bundle, "events.jsonl") : null;

  // The registry and the sealed bundle must tell the same story. If they don't, the evidence can't be relied on.
  if (registry && manifest && registry.verdict && manifest.verdict && registry.verdict !== manifest.verdict) {
    evidenceStatus = "TAMPERED";
    reasons.push(`registry verdict ${registry.verdict} differs from the sealed verdict ${String(manifest.verdict)}`);
  }

  const status: string | null = manifest?.status ?? registry?.status ?? null;
  const verdict: string | null = manifest?.verdict ?? registry?.verdict ?? null;
  const outcomes: Record<string, string> | null = manifest?.outcomes ?? assertions?.outcomes ?? null;
  const mode: string | null = manifest?.mode ?? spec?.mode ?? registry?.mode ?? null;
  const liveTask = (spec?.goal && typeof spec.goal === "object") || (spec?.qa && typeof spec.qa === "object");
  const scenario = liveTask ? undefined : mode ? findScenarioForRun(mode, typeof spec?.ordersExpected === "number" ? spec.ordersExpected : null) : undefined;
  const taskExpected: Scenario["expected"] = { status: "completed", verdict: "OPEN" };

  const steps: SummaryStep[] = (decisions ?? []).map((d, i) => {
    const p = describeProposal(d.proposal);
    return { step: typeof d.step === "number" ? d.step : i, tool: p.tool, proposal: p.text, reason: p.reason, decision: String(d.decision?.decision ?? "unknown").slice(0, 40), rule: clip(d.decision?.rule, 80), dispatched: d.dispatched === true, result: clip(d.result, 240) };
  });

  const containment: RunSummary["containment"] = [];
  for (const g of gateway ?? []) {
    if (g.decision === "deny") containment.push({ kind: "network", text: `${String(g.method ?? "")} ${String(g.target ?? "")}`.trim().slice(0, 240), detail: clip(g.reason, 120) });
  }
  for (const s of steps) {
    if (s.decision === "deny" || s.decision === "needs_approval") containment.push({ kind: "policy", text: s.proposal, detail: s.rule });
  }
  if ((events ?? []).some((e) => e.type === "run.wall_clock_expired")) containment.push({ kind: "limit", text: "Wall-clock limit reached", detail: "hard stop" });

  let approval: RunSummary["approval"] = null;
  const requested = (events ?? []).find((e) => e.type === "approval.requested");
  if (requested) {
    const replay = (events ?? []).find((e) => e.type === "approval.replay_probe");
    approval = {
      requested: true, cart: requested.cart ?? null, payloadSha256: clip(requested.payloadSha256, 64),
      granted: (events ?? []).some((e) => e.type === "approval.granted"), refused: (events ?? []).some((e) => e.type === "approval.refused"),
      replayStatus: typeof replay?.status === "number" ? replay.status : null, replayRefused: typeof replay?.refused === "boolean" ? replay.refused : null,
    };
  }

  const responseModels: string[] = Array.isArray(manifest?.model?.responseModels) ? manifest.model.responseModels.slice(0, 5).map(String) : [];
  const provider = typeof calls?.[0]?.provider === "string" ? calls[0].provider : manifest?.model?.kind === "stub" ? "local-model-stub" : manifest?.model?.kind === "vultr" ? "vultr-serverless-inference" : null;
  const model: RunSummary["model"] = manifest?.model || calls
    ? {
        provider, requested: clip(manifest?.model?.requested, 120) ?? clip(calls?.[0]?.requestedModel, 120), responseModels,
        calls: typeof manifest?.tokens?.calls === "number" ? manifest.tokens.calls : calls?.length ?? null,
        totalTokens: typeof manifest?.tokens?.total === "number" ? manifest.tokens.total : null,
        latencyMs: calls ? calls.reduce((n, c) => n + (typeof c.latencyMs === "number" ? c.latencyMs : 0), 0) : null,
      }
    : null;

  const files = Object.keys((manifest?.files ?? {}) as Record<string, string>);
  const started = typeof manifest?.startedAt === "string" ? manifest.startedAt : null;
  const finished = typeof manifest?.finishedAt === "string" ? manifest.finishedAt : null;
  const durationMs = started && finished ? Math.max(0, Date.parse(finished) - Date.parse(started)) : null;

  for (const [label, value] of [["manifest", manifest], ["verifier output", assertions], ["frozen specification", spec], ["store server state", server], ["policy decisions", decisions], ["model calls", calls], ["gateway log", gateway], ["event log", events]] as const) {
    if (value === null) notRetained.push(label);
  }

  let outcomeClass = classifyOutcome({ status, verdict, outcomes, evidenceStatus, expected: liveTask ? taskExpected : scenario?.expected ?? null });
  // Only the missing order may be failing: a wrong total or quantity is still reported as a failure.
  const failingChecks = (Array.isArray(assertions?.checks) ? assertions.checks : []).filter((c: { outcome?: string }) => c.outcome === "FAIL").map((c: { name?: string }) => c.name);
  const onlyMissingOrder = failingChecks.length > 0 && failingChecks.every((n: string | undefined) => n === "orders.count" || n === "checkout.reached");
  if (liveTask && outcomeClass === "verified_fail" && onlyMissingOrder && (events ?? []).some((e) => e.type === "approval.refused") && !(events ?? []).some((e) => e.type === "approval.granted")) outcomeClass = "order_not_approved";
  if (bundle && typeof anchor !== "string" && (evidenceStatus === "PASS" || evidenceStatus === "FAIL") && outcomeClass !== "unexpected_failure" && outcomeClass !== "cancelled") {
    outcomeClass = "incomplete_evidence";
    reasons.push("no separately recorded manifest hash, so a rewritten bundle couldn't be detected");
  }
  return {
    runId, source,
    mission: liveTask ? { id: "live-task", title: "Live task", purpose: clip(spec?.task, 300) ?? "", expected: taskExpected }
      : scenario ? { id: scenario.id, title: scenario.title, purpose: scenario.purpose, expected: scenario.expected } : null,
    task: clip(spec?.task, 500), userText: liveTask ? clip(spec?.goal?.userText ?? spec?.qa?.userText, 500) : null, status, verdict, outcomeClass, missionOutcome: missionOutcomeOf(outcomeClass),
    error: clip(manifest?.error ?? registry?.error, 300),
    tier: clip(manifest?.tier ?? registry?.tier, 40), codeSha: clip(manifest?.codeSha, 64), deployment: clip(manifest?.deployment, 80), mode,
    startedAt: started ?? registry?.createdAt ?? null, finishedAt: finished ?? registry?.updatedAt ?? null, durationMs, outcomes,
    checks: Array.isArray(assertions?.checks) ? assertions.checks.slice(0, 60) : [],
    expected: spec ? { ...spec.expected, ordersExpected: spec.ordersExpected, requireCheckoutReached: spec.requireCheckoutReached } : null,
    observed: server ? { totals: server.totals ?? null, coupon: clip(server.coupon, 40), orders: Array.isArray(server.orders) ? server.orders.length : null, checkoutReached: typeof server.checkoutReached === "boolean" ? server.checkoutReached : null } : null,
    model, steps, containment: containment.slice(0, 60), approval,
    screenshots: files.filter((f) => /^screenshots\/[A-Za-z0-9._-]{1,80}$/.test(f)),
    evidence: {
      status: evidenceStatus, integrity_status: integrityOf(evidenceStatus, typeof anchor === "string"), reasons: reasons.slice(0, 12).map((r) => r.slice(0, 200)), integrity: classified.integrity, files: classified.files,
      manifestSha256: anchor ?? null, anchored: typeof anchor === "string",
      available: files.filter((f) => /^[A-Za-z0-9._-]{1,80}\.(json|jsonl|md)$/.test(f)).concat(files.includes("manifest.json") || (bundle && existsSync(join(bundle, "manifest.json"))) ? ["manifest.json"] : []),
    },
    notRetained,
  };
}

export interface CompareRow { group: string; field: string; a: string; b: string; differs: boolean }
export interface RunComparison {
  a: { runId: string; title: string; outcomeClass: OutcomeClass };
  b: { runId: string; title: string; outcomeClass: OutcomeClass };
  rows: CompareRow[];
  differences: number;
  note: string;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "not recorded";
  return typeof v === "object" ? JSON.stringify(v).slice(0, 160) : String(v).slice(0, 160);
};
const usd = (c: unknown) => (typeof c === "number" ? `$${(c / 100).toFixed(2)}` : null);

/** Lays two recorded runs side by side. It reports recorded differences only, and draws no conclusion from them. */
export function compareRuns(a: RunSummary, b: RunSummary): RunComparison {
  const rows: CompareRow[] = [];
  const add = (group: string, field: string, x: unknown, y: unknown) => {
    const left = show(x);
    const right = show(y);
    rows.push({ group, field, a: left, b: right, differs: left !== right });
  };
  add("Result", "Outcome", a.outcomeClass, b.outcomeClass);
  add("Result", "Mission outcome", a.missionOutcome, b.missionOutcome);
  add("Result", "Recorded verdict", a.verdict, b.verdict);
  add("Result", "Run status", a.status, b.status);
  add("Result", "Evidence integrity", a.evidence.integrity_status, b.evidence.integrity_status);
  add("Mission", "Mission", a.mission?.title, b.mission?.title);
  add("Mission", "Store fixture", a.mode, b.mode);
  add("Mission", "Tier", a.tier, b.tier);
  add("Mission", "Code", a.codeSha?.slice(0, 12), b.codeSha?.slice(0, 12));
  add("Expected and observed", "Expected total", usd(a.expected?.totalCents), usd(b.expected?.totalCents));
  add("Expected and observed", "Observed total (store)", usd(a.observed?.totals?.totalCents), usd(b.observed?.totals?.totalCents));
  add("Expected and observed", "Expected discount", usd(a.expected?.discountCents), usd(b.expected?.discountCents));
  add("Expected and observed", "Observed discount (store)", usd(a.observed?.totals?.discountCents), usd(b.observed?.totals?.discountCents));
  add("Expected and observed", "Checkout reached (store)", a.observed?.checkoutReached, b.observed?.checkoutReached);
  add("Expected and observed", "Orders (store)", a.observed?.orders, b.observed?.orders);
  const sequence = (s: RunSummary, dispatchedOnly: boolean) => s.steps.filter((x) => !dispatchedOnly || x.dispatched).map((x) => x.tool ?? "unusable").join(" > ") || null;
  add("Actions", "Proposed", sequence(a, false), sequence(b, false));
  add("Actions", "Dispatched", sequence(a, true), sequence(b, true));
  const count = (s: RunSummary, d: string) => s.steps.filter((x) => x.decision === d).length;
  add("Policy", "Allowed", count(a, "allow"), count(b, "allow"));
  add("Policy", "Refused", count(a, "deny"), count(b, "deny"));
  add("Policy", "Held for approval", count(a, "needs_approval"), count(b, "needs_approval"));
  add("Model", "Provider", a.model?.provider, b.model?.provider);
  add("Model", "Requested model", a.model?.requested, b.model?.requested);
  add("Model", "Response model", a.model?.responseModels.join(", "), b.model?.responseModels.join(", "));
  add("Usage", "Duration (seconds)", a.durationMs === null ? null : (a.durationMs / 1000).toFixed(1), b.durationMs === null ? null : (b.durationMs / 1000).toFixed(1));
  add("Usage", "Model calls", a.model?.calls, b.model?.calls);
  add("Usage", "Tokens", a.model?.totalTokens, b.model?.totalTokens);
  const net = (s: RunSummary) => s.containment.filter((c) => c.kind === "network").length;
  add("Containment", "Gateway refusals", net(a), net(b));
  for (const name of new Set([...a.checks, ...b.checks].map((c) => c.name))) {
    const ca = a.checks.find((c) => c.name === name);
    const cb = b.checks.find((c) => c.name === name);
    // spec.sealed and session binding hold per-run hashes and ids, so compare their outcome only.
    add("Checks", name, ca?.outcome, cb?.outcome);
  }
  const title = (s: RunSummary) => s.mission?.title ?? s.mode ?? "Unknown mission";
  return {
    a: { runId: a.runId, title: title(a), outcomeClass: a.outcomeClass },
    b: { runId: b.runId, title: title(b), outcomeClass: b.outcomeClass },
    rows, differences: rows.filter((r) => r.differs).length,
    note: "Recorded differences only. A difference is not automatically a defect or a security finding.",
  };
}
