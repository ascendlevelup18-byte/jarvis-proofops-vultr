// ProofOps control plane: serves the operator UI and a small JSON API, runs missions one at a time, and streams
// live progress with Server-Sent Events. Holds the model key (if any); the browser worker never sees it.
//   node apps/proofops/src/server.ts [--port 4317] [--planner stub|vultr --model <id>] [--sandbox]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, normalize, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createStorefront } from "./storefront.ts";
import { startSigner } from "./signer.ts";
import { goalStubPlanner, stubPlanner, vultrPlanner, type Planner } from "./model.ts";
import { interpretTask } from "./tasks.ts";
import type { TaskGoal } from "./fixtures.ts";
import { runScenario, RUN_LIMITS, type ApprovalRequest, type RunConfig, type Tier } from "./runner.ts";
import { SCENARIOS, findScenario, type Scenario } from "./scenarios.ts";
import { RunStore } from "./store.ts";
import { classifyEvidence, pruneEvidence } from "./evidence.ts";
import { Action } from "./policy.ts";
import { compareRuns, readRunSummary, type RunSummary } from "./run-summary.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const UI_DIR = join(ROOT, "apps", "proofops", "ui");
const PORT = Number(arg("port", process.env.PROOFOPS_PORT ?? "4317"));
const HOST = process.env.PROOFOPS_HOST ?? "127.0.0.1";
const SANDBOX = process.argv.includes("--sandbox");
const PLANNER = arg("planner", process.env.PROOFOPS_PLANNER ?? "stub")!;
const MODEL = arg("model", process.env.PROOFOPS_MODEL);
const TRUST_PROXY = process.env.PROOFOPS_TRUST_PROXY === "1"; // only behind our own Caddy, which sets X-Forwarded-For
const MAX_RUNS_PER_DAY = Math.max(Number(process.env.PROOFOPS_MAX_RUNS_PER_DAY ?? "200") || 200, 1);
const EVIDENCE_KEEP = Math.max(Number(process.env.PROOFOPS_EVIDENCE_KEEP ?? "300") || 300, 10);
const MAX_LISTENERS = 50;
const EVIDENCE_ROOT = resolve(ROOT, arg("evidence", SANDBOX ? "evidence" : "evidence-local")!);
const DATA_DIR = resolve(ROOT, arg("data", "data-local")!);
mkdirSync(EVIDENCE_ROOT, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
// Listing full run ids makes every bundle reachable, and this system has no user accounts. So history is closed by
// default: only a direct local request on a local development server gets it, unless an operator opens it explicitly.
const HISTORY_ENV_OPEN = process.env.PROOFOPS_OPEN_HISTORY === "1";
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOCAL_DEV_SERVER = !TRUST_PROXY && !SANDBOX && (HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1");
if (HISTORY_ENV_OPEN) console.warn("PROOFOPS_OPEN_HISTORY=1: run history has no authentication. Anyone who can reach this server can read every run.");
function historyAllowed(req: IncomingMessage): boolean {
  if (HISTORY_ENV_OPEN) return true;
  if (!LOCAL_DEV_SERVER || req.headers["x-forwarded-for"] !== undefined) return false; // a proxy in front means it isn't local
  const peer = req.socket.remoteAddress ?? "";
  return LOOPBACK_HOST.test(String(req.headers.host ?? "")) && (peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1"); // Host check stops DNS rebinding
}
// Read-only archived bundles, such as the sealed live runs in this repository. Never written to or pruned.
const ARCHIVE_DIRS = (arg("archive", SANDBOX ? "" : "proof/vultr-live-20261104/runs-d14d24c") ?? "").split(",").map((d) => d.trim()).filter(Boolean).map((d) => resolve(ROOT, d));
const RUN_DIR = /^run_\d{14}_[0-9a-f]{8,16}$/;
const archive = new Map<string, { dir: string; anchor: string | undefined }>();
for (const root of ARCHIVE_DIRS) {
  if (!existsSync(root)) continue;
  const anchors = new Map<string, string>();
  try {
    for (const line of readFileSync(join(root, "ANCHORS.txt"), "utf8").split("\n")) {
      const [id, hash] = line.trim().split(/\s+/);
      if (id && hash) anchors.set(id, hash);
    }
  } catch { /* no anchors recorded: the summary says the check ran against the manifest only */ }
  for (const name of readdirSync(root)) if (RUN_DIR.test(name)) archive.set(name, { dir: join(root, name), anchor: anchors.get(name) });
}

let codeSha = "unknown";
try { codeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { /* not a checkout */ }

// ---- Long-lived components: signer (own process), storefront, run registry ----
const signer = await startSigner();
const store = createStorefront({ approvalPublicKey: signer.publicKey });
await new Promise<void>((r) => store.publicServer.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => store.trustedServer.listen(0, "127.0.0.1", r));
const storefront = {
  trustedBase: `http://127.0.0.1:${(store.trustedServer.address() as AddressInfo).port}`,
  publicPort: (store.publicServer.address() as AddressInfo).port,
};
const registry = new RunStore(join(DATA_DIR, "runs.db"));
const recovered = registry.recoverInterrupted();

// Fail closed at startup, not mid-run: no key, no live planner; no runsc or worker image, no sandboxed server.
function die(message: string): never {
  console.error(`ProofOps refused to start: ${message}`);
  process.exit(1);
}
let inferenceKey = "";
if (PLANNER === "vultr") {
  const envFile = process.env.PROOFOPS_INFERENCE_ENV_FILE ?? "/etc/proofops/inference.env";
  try { inferenceKey = /^PROOFOPS_INFERENCE_API_KEY=(.+)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim() ?? ""; } catch { /* reported below */ }
  if (!inferenceKey) die(`no inference key in ${envFile}`);
  if (!MODEL) die("--model is required with the vultr planner");
} else if (PLANNER !== "stub") die(`unknown planner ${PLANNER}`);
const IMAGE = arg("image", "proofops-worker:1.64.1")!;
const NO_CHROMIUM_SANDBOX = process.argv.includes("--chromium-no-sandbox") || process.env.PROOFOPS_CHROMIUM_NO_SANDBOX === "1";
if (SANDBOX) {
  try {
    const runtimes = execFileSync("docker", ["info", "--format", "{{json .Runtimes}}"], { encoding: "utf8" });
    if (!/"runsc"/.test(runtimes)) die("Docker has no runsc runtime; refusing to run without gVisor");
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  } catch (e) { die(`sandbox prerequisites missing: ${(e as Error).message.split("\n")[0]}`); }
}
// A task goal changes which scripted walk the stub takes. It never changes which provider runs, and there's no fallback.
const makePlanner = (goal?: TaskGoal): Planner => (PLANNER === "vultr" ? vultrPlanner({ apiKey: inferenceKey, model: MODEL! }) : goal ? goalStubPlanner(goal) : stubPlanner());
const TIER: Tier = SANDBOX ? (PLANNER === "vultr" ? "VULTR_GVISOR_LIVE_MODEL" : "VULTR_GVISOR_SCRIPTED") : PLANNER === "vultr" ? "LOCAL_LIVE_MODEL" : "LOCAL_MODEL_STUB";

// ---- Live run state (one mission at a time keeps the demo VM predictable) ----
interface Live {
  runId: string;
  scenario: Scenario;
  status: "running" | "awaiting_approval" | "completed" | "failed" | "timed_out" | "cancelled";
  events: Record<string, unknown>[];
  steps: Record<string, unknown>[];
  pendingApproval: (ApprovalRequest & { resolve: (token: string | null) => void }) | null;
  abort: AbortController;
  result: Record<string, unknown> | null;
  listeners: Set<ServerResponse>;
  /** Capability returned only to the browser that started the run; required to approve, reject or cancel it. */
  ownerToken: string;
}
let active: Live | null = null;
const finished = new Map<string, Live>();

function broadcast(live: Live, type: string, data: unknown) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of live.listeners) res.write(msg);
}

function snapshot(l: Live) {
  return {
    runId: l.runId, scenario: l.scenario, status: l.status, tier: TIER, planner: PLANNER === "vultr" ? MODEL : "local-model-stub",
    events: l.events, steps: l.steps, result: l.result,
    pendingApproval: l.pendingApproval ? { stepIndex: l.pendingApproval.stepIndex, element: l.pendingApproval.element, cart: l.pendingApproval.cart, payloadSha256: l.pendingApproval.payloadSha256 } : null,
  };
}

async function startRun(scenario: Scenario, idempotencyKey: string | null, goal?: TaskGoal): Promise<{ runId: string; created: boolean; runToken?: string }> {
  const runId = `run_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(8).toString("hex")}`;
  const reg = registry.create({ id: runId, idempotencyKey, mode: scenario.mode, tier: TIER });
  if (!reg.created) return { runId: reg.run.id, created: false };
  registry.update(runId, { status: "running" });
  const live: Live = { runId, scenario, status: "running", events: [], steps: [], pendingApproval: null, abort: new AbortController(), result: null, listeners: new Set(), ownerToken: randomBytes(24).toString("hex") };
  active = live;
  const cfg: RunConfig = {
    runId, mode: scenario.mode, task: scenario.task, ordersExpected: scenario.ordersExpected,
    planner: makePlanner(goal), tier: TIER, storefront, goal,
    worker: SANDBOX
      ? { kind: "sandbox", socketRoot: "/run/proofops", limits: { image: IMAGE, runtime: "runsc", memoryMb: 1024, cpus: 1, pids: 256, chromiumNoSandbox: NO_CHROMIUM_SANDBOX } }
      : { kind: "local" },
    evidenceRoot: EVIDENCE_ROOT, codeSha, deployment: arg("deployment", SANDBOX ? "vultr" : "local")!,
    wallClockMs: scenario.wallClockMs, signal: live.abort.signal,
    observer: (e) => {
      (e.kind === "event" ? live.events : live.steps).push(e.data);
      broadcast(live, e.kind, e.data);
    },
    approval: scenario.approvals === "operator"
      ? (req) => new Promise<string | null>((resolveApproval) => {
          const timer = setTimeout(() => settle(null), 120_000);
          const settle = (token: string | null) => { clearTimeout(timer); live.pendingApproval = null; live.status = "running"; resolveApproval(token); };
          live.pendingApproval = { ...req, resolve: settle };
          live.status = "awaiting_approval";
          broadcast(live, "approval", snapshot(live).pendingApproval);
          live.abort.signal.addEventListener("abort", () => settle(null), { once: true });
        })
      : undefined,
  };
  void runScenario(cfg)
    .then((r) => {
      live.status = r.status;
      live.result = { verdict: r.verdict, outcomes: r.report.outcomes, checks: r.report.checks, error: r.error, steps: r.steps, manifestSha256: r.manifestSha256 };
      registry.update(runId, { status: r.status, verdict: r.verdict, error: r.error, evidenceDir: r.evidenceDir, manifestSha256: r.manifestSha256 });
    })
    .catch((e: Error) => {
      live.status = "failed";
      live.result = { verdict: "INCONCLUSIVE", error: e.message };
      registry.update(runId, { status: "failed", error: e.message });
    })
    .finally(() => {
      broadcast(live, "done", snapshot(live));
      for (const res of live.listeners) res.end();
      live.listeners.clear();
      finished.set(runId, live);
      for (const old of [...finished.keys()].slice(0, Math.max(0, finished.size - 50))) finished.delete(old); // bounded memory
      try { pruneEvidence(EVIDENCE_ROOT, EVIDENCE_KEEP); } catch { /* retention must never break a run */ }
      if (active === live) active = null;
    });
  return { runId, created: true, runToken: live.ownerToken };
}

// ---- HTTP ----
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".json": "application/json", ".jsonl": "application/x-ndjson", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml" };
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
};
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 8_192) throw new Error("too large"); }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
// Mutating calls must come from this UI (same-origin fetch with a custom header), which blocks cross-site forms.
const sameOrigin = (req: IncomingMessage) => req.headers["x-proofops"] === "1";
const RUNS_PER_MINUTE = Math.min(Math.max(Number(process.env.PROOFOPS_RUNS_PER_MIN ?? "30") || 30, 1), 120);
const perIp = new Map<string, number[]>();
// Behind Caddy every socket comes from 127.0.0.1, so the client address must come from the header Caddy sets.
// Only honoured when configured: otherwise anyone could spoof the header to dodge the limit.
const clientIp = (req: IncomingMessage) => {
  const xff = TRUST_PROXY ? req.headers["x-forwarded-for"] : undefined;
  return (typeof xff === "string" ? xff.split(",").at(-1)?.trim() : null) || (req.socket.remoteAddress ?? "?");
};
function overLimit(table: Map<string, number[]>, req: IncomingMessage, limit: number): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  if (table.size > 5_000) table.clear(); // bounded memory under address spraying
  const hits = (table.get(ip) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  table.set(ip, hits);
  return hits.length > limit;
}
const rateLimited = (req: IncomingMessage) => overLimit(perIp, req, RUNS_PER_MINUTE);
const HASHING_READS_PER_MINUTE = Math.max(Number(process.env.PROOFOPS_READS_PER_MIN ?? "240") || 240, 1);
const readsPerIp = new Map<string, number[]>();
const readLimited = (req: IncomingMessage) => overLimit(readsPerIp, req, HASHING_READS_PER_MINUTE);

async function serveFile(res: ServerResponse, base: string, rel: string) {
  const full = normalize(join(base, rel));
  if (full !== base && !full.startsWith(base + sep)) return json(res, 403, { error: "forbidden" });
  try {
    if (!(await stat(full)).isFile()) throw new Error();
    // A link inside the folder must not lead out of it.
    const realBase = await realpath(base);
    if (!(await realpath(full)).startsWith(realBase + sep)) throw new Error();
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream", "cache-control": "no-store", ...SECURITY_HEADERS });
    res.end(await readFile(full));
  } catch {
    json(res, 404, { error: "not_found" });
  }
}

/** Summary of a finished run from its sealed files, or null if this server has never heard of it. */
function summaryOf(id: string): RunSummary | null {
  const row = registry.get(id);
  if (row) {
    return readRunSummary({ runId: id, dir: row.evidence_dir, anchor: row.manifest_sha256, source: "registry",
      registry: { status: row.status, verdict: row.verdict, error: row.error, tier: row.tier, mode: row.mode, createdAt: row.created_at, updatedAt: row.updated_at } });
  }
  const a = archive.get(id);
  return a ? readRunSummary({ runId: id, dir: a.dir, anchor: a.anchor, source: "archive" }) : null;
}
const runIsLive = (id: string) => active?.runId === id;

const ownerOk = (req: IncomingMessage, live: Live | undefined | null) => {
  const given = Buffer.from(String(req.headers["x-run-token"] ?? ""));
  const want = Buffer.from(live?.ownerToken ?? "");
  return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://ui.local");
    const p = url.pathname;
    if ((req.method === "GET" || req.method === "HEAD") && p === "/api/health") {
      return json(res, 200, { ok: true, service: "jarvis-proofops", tier: TIER, planner: PLANNER === "vultr" ? { provider: "vultr-serverless-inference", model: MODEL } : { provider: "local-model-stub" },
        isolation: SANDBOX ? "gvisor-runsc" : "none (local development)", codeSha: codeSha.slice(0, 12), active: active !== null, recoveredOnStart: recovered });
    }
    if (req.method === "GET" && p === "/api/scenarios") return json(res, 200, SCENARIOS);
    // Public history: outcomes only. Full run ids are capabilities for evidence, and paths never leave the server.
    if (req.method === "GET" && p === "/api/runs") {
      return json(res, 200, registry.list(30).map((r) => ({ ref: createHash("sha256").update(r.id).digest("hex").slice(0, 8), mode: r.mode, tier: r.tier, status: r.status, verdict: r.verdict, at: r.created_at })));
    }
    // Read-only history of finished runs: the registry's, then any archived bundles. Newest first.
    if (req.method === "GET" && p === "/api/history") {
      if (!historyAllowed(req)) return json(res, 403, { error: "history_private" });
      if (readLimited(req)) return json(res, 429, { error: "rate_limited" });
      const ids = [...registry.list(30).map((r) => r.id).filter((id) => !runIsLive(id)), ...[...archive.keys()].filter((id) => !registry.get(id)).sort().reverse()].slice(0, 100);
      return json(res, 200, ids.map((id) => summaryOf(id)).filter((x): x is RunSummary => x !== null).map((x) => ({
        runId: x.runId, source: x.source, title: x.mission?.title ?? x.mode, tier: x.tier, status: x.status, verdict: x.verdict, outcomeClass: x.outcomeClass,
        evidenceStatus: x.evidence.status, provider: x.model?.provider ?? null, model: x.model?.requested ?? null, at: x.startedAt,
      })));
    }
    if (req.method === "GET" && p === "/api/compare") {
      const a = url.searchParams.get("a") ?? "";
      const b = url.searchParams.get("b") ?? "";
      if (!RUN_DIR.test(a) || !RUN_DIR.test(b)) return json(res, 400, { error: "bad_run_id" });
      if (readLimited(req)) return json(res, 429, { error: "rate_limited" });
      if (runIsLive(a) || runIsLive(b)) return json(res, 409, { error: "run_not_finished" });
      const sa = summaryOf(a);
      const sb = summaryOf(b);
      if (!sa || !sb) return json(res, 404, { error: "not_found" });
      return json(res, 200, compareRuns(sa, sb));
    }
    // What this deployment actually enforces, read from the running code and configuration.
    if (req.method === "GET" && p === "/api/trust") {
      return json(res, 200, {
        tier: TIER, codeSha: codeSha.slice(0, 12), isolation: SANDBOX ? "gvisor-runsc" : "none (local development)",
        planner: PLANNER === "vultr" ? { provider: "vultr-serverless-inference", model: MODEL, live: true } : { provider: "local-model-stub", model: "scripted", live: false },
        silentFallback: false, actions: Action.options.map((o) => o.shape.tool.value),
        limits: { ...RUN_LIMITS, activeMissions: 1, missionsPerRollingDay: MAX_RUNS_PER_DAY, startsPerMinutePerAddress: RUNS_PER_MINUTE, evidenceBundlesKept: EVIDENCE_KEEP },
        missions: SCENARIOS.map((x) => ({ title: x.title, wallClockSeconds: x.wallClockMs / 1000, approval: x.approvals, expected: x.expected })),
        evidence: "Unkeyed SHA-256 file checksums and a separately recorded manifest hash. Not signatures. Someone who controls this host could rewrite both.",
        approvals: "Ed25519 token from a separate signer process, bound to the run, the action and the exact cart, usable once. Held in memory, so a restart ends it.",
        openHistory: historyAllowed(req), archivedRuns: archive.size,
      });
    }
    if (req.method === "POST" && p === "/api/runs") {
      if (!sameOrigin(req)) return json(res, 403, { error: "missing_ui_header" });
      if (rateLimited(req)) return json(res, 429, { error: "rate_limited" });
      const body = await readJson(req);
      const scenario = findScenario(String(body.scenario ?? ""));
      if (!scenario) return json(res, 400, { error: "unknown_scenario" });
      if (active) return json(res, 409, { error: "busy" });
      // Global budget (also caps model spend: at most 14 calls and 60k tokens per run).
      if (registry.countSince(new Date(Date.now() - 86_400_000).toISOString()) >= MAX_RUNS_PER_DAY) return json(res, 429, { error: "daily_limit" });
      const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 128) : null;
      return json(res, 202, await startRun(scenario, key));
    }
    // Live Tasks: validate the person's text into a goal, then use the same run path as every mission.
    if (req.method === "POST" && p === "/api/tasks") {
      if (!sameOrigin(req)) return json(res, 403, { error: "missing_ui_header" });
      if (rateLimited(req)) return json(res, 429, { error: "rate_limited" });
      const body = await readJson(req);
      const task = interpretTask(body.text);
      if (!task.ok) return json(res, 422, { error: task.kind === "clarify" ? "needs_clarification" : "unsupported_task", message: task.message });
      if (active) return json(res, 409, { error: "busy" });
      if (registry.countSince(new Date(Date.now() - 86_400_000).toISOString()) >= MAX_RUNS_PER_DAY) return json(res, 429, { error: "daily_limit" });
      const given = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 128) : null;
      const key = given ? `task:${createHash("sha256").update(task.goal.userText).digest("hex").slice(0, 16)}:${given}` : null;
      const scenario: Scenario = { id: "live-task", title: "Live task", purpose: task.plannerTask, mode: task.mode, task: task.plannerTask, ordersExpected: task.goal.placeOrder ? 1 : 0,
        approvals: task.goal.placeOrder ? "operator" : "none", wallClockMs: task.wallClockMs, forcedMalicious: false, expected: { status: "completed", verdict: "OPEN" } };
      const started = await startRun(scenario, key, task.goal);
      return json(res, 202, { ...started, understood: task.understood, plannerTask: task.plannerTask, userText: task.goal.userText });
    }
    const m = /^\/api\/runs\/(run_[0-9]{14}_[0-9a-f]{8,16})(\/.*)?$/.exec(p);
    if (m) {
      const id = m[1]!;
      const sub = m[2] ?? "";
      const live = active?.runId === id ? active : finished.get(id);
      if (req.method === "GET" && sub === "") {
        if (live) return json(res, 200, snapshot(live));
        const row = registry.get(id);
        if (!row) return json(res, 404, { error: "not_found" });
        return json(res, 200, { runId: id, status: row.status, verdict: row.verdict, manifestSha256: row.manifest_sha256 });
      }
      if (req.method === "GET" && sub === "/summary") {
        if (runIsLive(id)) return json(res, 409, { error: "run_not_finished" });
        if (readLimited(req)) return json(res, 429, { error: "rate_limited" });
        const summary = summaryOf(id);
        return summary ? json(res, 200, summary) : json(res, 404, { error: "not_found" });
      }
      if (req.method === "GET" && sub === "/stream") {
        if (!live) return json(res, 404, { error: "not_found" });
        if (live.listeners.size >= MAX_LISTENERS) return json(res, 503, { error: "too_many_viewers" });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...SECURITY_HEADERS });
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(live))}\n\n`);
        if (live !== active) { res.write(`event: done\ndata: ${JSON.stringify(snapshot(live))}\n\n`); return res.end(); }
        live.listeners.add(res);
        req.on("close", () => live.listeners.delete(res));
        return;
      }
      if (req.method === "POST" && (sub === "/approve" || sub === "/reject")) {
        if (!sameOrigin(req)) return json(res, 403, { error: "missing_ui_header" });
        if (!ownerOk(req, live)) return json(res, 403, { error: "not_run_owner" });
        const body = await readJson(req);
        // Claim the pending request synchronously (no await in between), so two simultaneous decisions can never
        // both reach the signer: the first claims it, every other caller sees nothing pending.
        const pending = live?.pendingApproval;
        if (!live || !pending) return json(res, 409, { error: "no_pending_approval" });
        if (body.payloadSha256 !== pending.payloadSha256) return json(res, 409, { error: "approval_payload_changed" });
        live.pendingApproval = null;
        if (sub === "/reject") { pending.resolve(null); return json(res, 200, { ok: true }); }
        try {
          const token = await signer.sign({ operator: "demo-operator", workspace: "demo-workspace", runId: id, payloadSha256: pending.payloadSha256 });
          pending.resolve(token);
          return json(res, 200, { ok: true });
        } catch {
          pending.resolve(null); // signer failure is a refusal, never a silent approval
          return json(res, 503, { error: "signer_unavailable" });
        }
      }
      if (req.method === "POST" && sub === "/cancel") {
        if (!sameOrigin(req)) return json(res, 403, { error: "missing_ui_header" });
        if (!ownerOk(req, live)) return json(res, 403, { error: "not_run_owner" });
        if (live !== active || !live) return json(res, 409, { error: "not_running" });
        live.abort.abort();
        return json(res, 202, { ok: true });
      }
      if (req.method === "GET" && sub === "/verify-evidence") {
        if (readLimited(req)) return json(res, 429, { error: "rate_limited" });
        // Re-hashes the bundle on disk and compares it with the manifest hash anchored in the registry.
        const row = registry.get(id);
        const arch = row ? undefined : archive.get(id);
        const dir = row?.evidence_dir ?? arch?.dir;
        if (!dir) return json(res, 404, { error: "not_found" });
        const anchor = row ? row.manifest_sha256 : arch?.anchor;
        const c = classifyEvidence(dir, anchor);
        return json(res, 200, { ...c, runId: id, anchoredManifestSha256: anchor ?? null, kind: "sha256-checksum (not a signature)", ok: c.status === "PASS" || c.status === "FAIL" });
      }
      const f = /^\/evidence\/([A-Za-z0-9._/-]{1,120})$/.exec(sub);
      if (req.method === "GET" && f && !f[1]!.includes("..")) return serveFile(res, archive.get(id)?.dir ?? join(EVIDENCE_ROOT, id), f[1]!);
      return json(res, 404, { error: "not_found" });
    }
    if (req.method === "GET" || req.method === "HEAD") return serveFile(res, UI_DIR, p === "/" ? "index.html" : p.slice(1));
    return json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return json(res, 400, { error: "bad_request", detail: (e as Error).message.slice(0, 120) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`JARVIS ProofOps control plane on http://${HOST}:${PORT}  (tier ${TIER}, code ${codeSha.slice(0, 7)})`);
  if (!existsSync(join(UI_DIR, "index.html"))) console.log("warning: UI files missing");
});
const shutdown = async () => {
  active?.abort.abort();
  server.close();
  signer.stop();
  await store.close();
  registry.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
