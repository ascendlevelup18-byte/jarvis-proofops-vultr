// One ProofOps run, end to end:
//   freeze spec -> storefront session -> per-run gateway -> disposable worker -> plan/policy/dispatch loop
//   -> control-plane verification reads -> server-side state -> teardown -> verifier -> evidence bundle.
// The model proposes; the policy decides; the worker executes; the verifier judges; the evidence records it all.
import { mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { freezeSpec, type FixtureMode, type FrozenSpec, type TaskGoal } from "./fixtures.ts";
import { createGateway, type GatewayEvent } from "./gateway.ts";
import { checkAction, type Observation, type PolicyDecision, type RunScope } from "./policy.ts";
import { launchWorker, type SandboxLimits, type WorkerHandle } from "./worker-client.ts";
import type { ModelCallRecord, Planner } from "./model.ts";
import { verify, type VerifierReport } from "./verifier.ts";
import { STORE_HOST, type SessionState } from "./storefront.ts";
import { cartPayloadSha256 } from "./approval.ts";

/** Evidence tier. Scripted and live-model runs are never merged; the tier is sealed into every manifest. */
export type Tier = "LOCAL_MODEL_STUB" | "LOCAL_LIVE_MODEL" | "VULTR_GVISOR_SCRIPTED" | "VULTR_GVISOR_LIVE_MODEL";

export interface ApprovalRequest {
  runId: string;
  stepIndex: number;
  element: string;
  cart: { sku: string; quantity: number; coupon: string | null; totalCents: number };
  payloadSha256: string;
}

export interface RunConfig {
  mode: FixtureMode;
  runId?: string;
  task?: string;
  ordersExpected?: number;
  /** A validated Live Task. The planner only ever sees cfg.task, generated from this. */
  goal?: TaskGoal;
  /** Operator approval for consequential steps. Returns a signed one-time token, or null when refused or timed out. */
  approval?: (req: ApprovalRequest) => Promise<string | null>;
  /** Test hook: receives the worker handle right after launch. */
  onWorker?: (w: WorkerHandle) => void;
  /** Live feed for the UI: every event and every step record as it happens. */
  observer?: (e: { kind: "event" | "step"; data: Record<string, unknown> }) => void;
  planner: Planner;
  tier: Tier;
  storefront: { trustedBase: string; publicPort: number };
  worker: { kind: "local" } | { kind: "sandbox"; socketRoot: string; limits: SandboxLimits };
  evidenceRoot: string;
  codeSha: string;
  deployment: string; // e.g. "local-windows" or "vultr:<instance-id>"
  maxSteps?: number;
  wallClockMs?: number;
  /** External cancellation (operator pressed Cancel). */
  signal?: AbortSignal;
  maxModelCalls?: number;
  /** Hard per-run token budget, summed from the provider's reported usage. */
  maxTotalTokens?: number;
}

export interface StepRecord {
  step: number;
  at: string;
  observationEpoch: number;
  model: ModelCallRecord;
  proposal: unknown;
  policy: PolicyDecision;
  dispatched: boolean;
  approved?: boolean;
  result?: string;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled";
  verdict: VerifierReport["verdict"];
  report: VerifierReport;
  evidenceDir: string;
  steps: number;
  error: string | null;
  /** SHA-256 of manifest.json: the anchor kept outside the bundle (registry, API). A checksum, not a signature. */
  manifestSha256: string;
}

/** The element as the policy saw it; the worker refuses to act if it no longer matches. */
function expectOf(obs: Observation, ref: string) {
  const e = obs.elements.find((x) => x.ref === ref);
  return e ? { tag: e.tag, href: e.href, formAction: e.formAction, consequential: e.consequential, name: e.name } : {};
}

const newRunId = () => `run_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(4).toString("hex")}`;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function listen(server: Server, where: { port: number; host: string } | { path: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if ("path" in where) server.listen(where.path, resolve);
    else server.listen(where.port, where.host, resolve);
  });
}

/** Per-run budgets when a caller sets none. Exported so the UI can show the real numbers. */
export const RUN_LIMITS = { maxSteps: 12, maxModelCalls: 14, maxTotalTokens: 60_000 } as const;

export async function runScenario(cfg: RunConfig): Promise<RunResult> {
  const runId = cfg.runId ?? newRunId();
  const maxSteps = cfg.maxSteps ?? RUN_LIMITS.maxSteps;
  const deadline = Date.now() + (cfg.wallClockMs ?? 120_000);
  const maxModelCalls = cfg.maxModelCalls ?? RUN_LIMITS.maxModelCalls;
  const maxTotalTokens = cfg.maxTotalTokens ?? RUN_LIMITS.maxTotalTokens;
  const dir = join(cfg.evidenceRoot, runId);
  // A run id is used once: never overwrite an earlier run's evidence.
  try {
    await mkdir(dir, { recursive: false });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`evidence for ${runId} already exists; run ids are single-use`);
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await mkdir(cfg.evidenceRoot, { recursive: true });
    await mkdir(dir, { recursive: false });
  }
  await mkdir(join(dir, "screenshots"), { recursive: true });
  await mkdir(join(dir, "observations"), { recursive: true });

  const events: Record<string, unknown>[] = [];
  const ev = (type: string, data: Record<string, unknown> = {}) => {
    const e = { at: new Date().toISOString(), runId, type, ...data };
    events.push(e);
    cfg.observer?.({ kind: "event", data: e });
  };
  const files: Record<string, string> = {}; // relative path -> sha256
  const put = async (rel: string, data: Buffer | string) => {
    await writeFile(join(dir, rel), data);
    files[rel] = sha256(data);
  };

  // 1. Freeze the assertions before anything else happens.
  const spec: FrozenSpec = freezeSpec(cfg.mode, cfg.task, cfg.ordersExpected ?? 0, cfg.goal);
  await put("spec.json", JSON.stringify(spec, null, 2));
  ev("spec.frozen", { specSha256: spec.specSha256 });

  // 2. A fresh storefront session for this run.
  const sres = await fetch(`${cfg.storefront.trustedBase}/sessions`, { method: "POST", body: JSON.stringify({ runId, mode: cfg.mode, quantityField: cfg.goal !== undefined }) });
  const { sid, basePath } = (await sres.json()) as { sid: string; basePath: string };
  const scope: RunScope = {
    base: `http://${STORE_HOST}${basePath}`,
    navigablePaths: ["/", "/cart", "/checkout"],
    fillableInputs: cfg.goal && cfg.goal.quantity > 1 ? ["code", "quantity"] : ["code"],
    consequentialPaths: ["/checkout/submit"],
    maxSteps,
  };
  await put("scope.json", JSON.stringify({ ...scope, task: spec.task, mode: cfg.mode }, null, 2));
  ev("store.session_created", { sid });

  // 3. The run's own gateway: TCP on loopback for the LOCAL tier, a Unix socket for the sandbox.
  const gatewayEvents: GatewayEvent[] = [];
  const gateway = createGateway({
    runId, allowedHost: STORE_HOST, allowedPathPrefix: basePath,
    upstream: { host: "127.0.0.1", port: cfg.storefront.publicPort },
    onEvent: (e) => {
      gatewayEvents.push(e);
      if (e.decision === "deny") ev("gateway.denied", { reason: e.reason, method: e.method, target: e.target });
    },
  });
  let socketDir: string | null = null;
  let proxyUrl = "";
  if (cfg.worker.kind === "sandbox") {
    socketDir = join(cfg.worker.socketRoot, runId);
    // Per-run directory: traversable but not listable; the socket is connectable by the worker's uid (10001).
    await mkdir(socketDir, { recursive: true, mode: 0o711 });
    await listen(gateway, { path: join(socketDir, "gw.sock") });
    await chmod(join(socketDir, "gw.sock"), 0o666);
  } else {
    await listen(gateway, { port: 0, host: "127.0.0.1" });
    proxyUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  }
  ev("gateway.listening", { kind: cfg.worker.kind });

  const steps: StepRecord[] = [];
  const modelCalls: ModelCallRecord[] = [];
  let worker: WorkerHandle | null = null;
  let status: RunResult["status"] = "completed";
  let stopReason: "timed_out" | "cancelled" | null = null;
  let stopTimer: NodeJS.Timeout | undefined;
  const plannerAbort = new AbortController(); // cancels an in-flight model call when the run stops
  let error: string | null = null;
  let dom: { subtotal: string | null; discount: string | null; total: string | null; checkoutMarker: boolean } | null = null;
  let cleanup = { workerGone: null as boolean | null, detail: "not started" };
  let screenshotCount = 0;
  let approvalsGranted = 0;
  let hostObserved: Record<string, unknown> | null = null;

  const shot = async (name: string) => {
    const r = await worker!.call<{ png: string; url: string }>("screenshot", {}, 15_000);
    await put(`screenshots/${name}.png`, Buffer.from(r.png, "base64"));
    screenshotCount += 1;
    ev("screenshot", { file: `screenshots/${name}.png`, url: r.url });
  };

  try {
    worker = await launchWorker(
      cfg.worker.kind === "local"
        ? { kind: "local", runId, proxyUrl }
        : { kind: "sandbox", runId, socketDir: socketDir!, limits: cfg.worker.limits },
    );
    ev("worker.launched", { kind: worker.kind, container: worker.containerName, args: worker.launchArgs });
    cfg.onWorker?.(worker);
    // Fail closed: for a sandboxed run, Docker itself must report the requested runtime. Never trust the flag alone.
    if (cfg.worker.kind === "sandbox") {
      hostObserved = await worker.inspect();
      ev("sandbox.host_observed", { ...hostObserved });
      if (hostObserved?.runtime !== cfg.worker.limits.runtime) {
        throw new Error(`sandbox_runtime_mismatch: requested ${cfg.worker.limits.runtime}, Docker reports ${String(hostObserved?.runtime)}`);
      }
    }
    // Hard stop: on wall-clock expiry or cancellation the worker is destroyed immediately, which fails any
    // in-flight call; the run then records the real stop reason instead of waiting for a step boundary.
    const w = worker;
    const hardStop = (reason: "timed_out" | "cancelled") => {
      if (stopReason) return;
      stopReason = reason;
      plannerAbort.abort();
      ev(reason === "timed_out" ? "run.wall_clock_expired" : "run.cancel_requested", {});
      void w.destroy();
    };
    stopTimer = setTimeout(() => hardStop("timed_out"), Math.max(0, deadline - Date.now()));
    if (cfg.signal?.aborted) hardStop("cancelled");
    cfg.signal?.addEventListener("abort", () => hardStop("cancelled"), { once: true });
    const started = await worker.call<Record<string, unknown>>("start", { startUrl: scope.base }, 45_000);
    ev("worker.started", started);

    let consecutiveInvalid = 0;
    let tokensUsed = 0;
    for (let step = 0; step < maxSteps; step++) {
      if (stopReason) break;
      if (modelCalls.length >= maxModelCalls) { status = "failed"; error = "model call budget exhausted"; break; }
      const obs = await worker.call<Observation>("observe");
      await put(`observations/step-${String(step).padStart(2, "0")}.json`, JSON.stringify(obs, null, 2));
      // A planner that ignores the signal cannot hold the run open: the stop wins the race.
      const stopped = new Promise<ModelCallRecord>((resolve) => {
        const onStop = () => resolve({ provider: cfg.planner.kind === "vultr" ? "vultr-serverless-inference" : "local-model-stub", requestedModel: cfg.planner.model,
          responseModel: null, responseId: null, usage: null, latencyMs: 0, rawContent: "", parsed: null, error: "run stopped before the model replied" });
        if (plannerAbort.signal.aborted) onStop();
        else plannerAbort.signal.addEventListener("abort", onStop, { once: true });
      });
      const call = await Promise.race([cfg.planner.next({
        task: spec.task, allowedPaths: scope.navigablePaths, observation: obs,
        history: steps.map((s) => ({ action: s.proposal, decision: s.policy.decision, rule: s.policy.rule, result: s.result })),
      }, plannerAbort.signal), stopped]);
      modelCalls.push(call);
      if (stopReason) { ev("model.reply_after_stop_discarded", { step }); break; } // never act on a late reply
      tokensUsed += call.usage?.totalTokens ?? 0;
      if (tokensUsed > maxTotalTokens) { status = "failed"; error = `token budget exhausted (${tokensUsed} > ${maxTotalTokens})`; ev("run.token_budget_exhausted", { tokensUsed }); break; }
      const decision = call.error
        ? ({ decision: "deny", rule: "model_error", detail: call.error } as PolicyDecision)
        : call.parsed === null
          ? ({ decision: "deny", rule: "invalid_model_output", detail: "reply was not one JSON object" } as PolicyDecision)
          : checkAction(call.parsed, obs, scope, step);
      const rec: StepRecord = { step, at: new Date().toISOString(), observationEpoch: obs.epoch, model: call, proposal: call.parsed, policy: decision, dispatched: false };
      steps.push(rec);
      ev("policy.decision", { step, decision: decision.decision, rule: decision.rule, detail: "detail" in decision ? decision.detail : undefined });

      if (decision.decision === "needs_approval" && cfg.approval) {
        // Pause for a human. The cart shown for approval comes from the store's own server state, not the page.
        const a = call.parsed as { ref: string; epoch: number };
        const st = (await (await fetch(`${cfg.storefront.trustedBase}/sessions/${sid}`)).json()) as SessionState;
        if (st.cart && st.totals) {
          const cart = { sku: st.cart.sku, quantity: st.cart.quantity, coupon: st.coupon, totalCents: st.totals.totalCents };
          const payloadSha256 = cartPayloadSha256(cart);
          ev("approval.requested", { step, cart, payloadSha256 });
          const token = await cfg.approval({ runId, stepIndex: step, element: obs.elements.find((e) => e.ref === a.ref)?.text ?? a.ref, cart, payloadSha256 });
          if (token) {
            approvalsGranted += 1;
            ev("approval.granted", { step, payloadSha256 });
            try {
              const r = await worker.call<{ url: string }>("submitApproved", { ref: a.ref, epoch: a.epoch, token, expect: expectOf(obs, a.ref) });
              rec.dispatched = true;
              rec.approved = true;
              rec.result = `approved and submitted: ${r.url}`;
            } catch (e) {
              rec.dispatched = true;
              rec.approved = true;
              rec.result = `worker error: ${(e as Error).message}`;
            }
            await shot(`step-${String(step).padStart(2, "0")}-approved`);
            // Negative control: replay the same token straight at the store, bypassing the browser and policy.
            const replay = await fetch(`http://127.0.0.1:${cfg.storefront.publicPort}${basePath}checkout/submit`, {
              method: "POST", body: new URLSearchParams({ approval: token }), redirect: "manual",
            }).catch(() => null);
            ev("approval.replay_probe", { status: replay?.status ?? null, refused: replay?.status === 403 });
          } else {
            rec.result = "operator did not approve";
            ev("approval.refused", { step });
          }
          cfg.observer?.({ kind: "step", data: rec as unknown as Record<string, unknown> });
          continue;
        }
      }

      if (decision.decision !== "allow") {
        cfg.observer?.({ kind: "step", data: { ...rec, result: decision.detail } as unknown as Record<string, unknown> });
        rec.result = decision.detail;
        consecutiveInvalid = decision.rule === "invalid_model_output" || decision.rule === "model_error" ? consecutiveInvalid + 1 : 0;
        if (consecutiveInvalid >= 3) { status = "failed"; error = "three consecutive unusable model replies"; break; }
        continue; // attempted -> denied -> not dispatched
      }
      consecutiveInvalid = 0;
      const d = decision.dispatch;
      if (d.op === "finish") {
        rec.dispatched = true;
        rec.result = "finished (the planner's claim is not the verdict)";
        cfg.observer?.({ kind: "step", data: rec as unknown as Record<string, unknown> });
        break;
      }
      try {
        const r = await worker.call<{ url: string }>(d.op, d.op === "navigate" ? { url: d.url } : d.op === "click" ? { ref: d.ref, epoch: d.epoch, expect: expectOf(obs, d.ref) } : { ref: d.ref, epoch: d.epoch, value: d.value, expect: expectOf(obs, d.ref) });
        rec.dispatched = true;
        rec.result = `ok ${r.url}`;
      } catch (e) {
        rec.dispatched = true;
        rec.result = `worker error: ${(e as Error).message}`;
        // A browser that stops answering is a hang, not a step failure: stop the run now.
        if (/worker_timeout|Timeout \d+ms exceeded/.test((e as Error).message)) {
          cfg.observer?.({ kind: "step", data: rec as unknown as Record<string, unknown> });
          throw e;
        }
      }
      if (step === 0 || d.op === "click") await shot(`step-${String(step).padStart(2, "0")}`);
      cfg.observer?.({ kind: "step", data: rec as unknown as Record<string, unknown> });
    }
    if (status === "completed" && steps.length >= maxSteps && steps.at(-1)?.policy.decision !== "allow") {
      // Ran out of steps without a finish.
      status = "failed";
      error = error ?? "step budget exhausted";
    }

    // 4. Verification reads by the control plane (not the model): final page, then the cart.
    if (stopReason) throw new Error(stopReason === "timed_out" ? "wall clock limit reached" : "cancelled by operator");
    try {
      const finalRead = await worker.call<{ values: Record<string, string | null> }>("read", { selectors: { marker: spec.selectors.checkoutMarker } });
      await shot("final");
      const cartRead = await worker.call<{ status: number | null }>("navigate", { url: new URL("cart", scope.base).toString() });
      const totals = await worker.call<{ values: Record<string, string | null> }>("read", {
        selectors: { subtotal: spec.selectors.subtotal, discount: spec.selectors.discount, total: spec.selectors.total },
      });
      await shot("verify-cart");
      dom = { subtotal: totals.values.subtotal ?? null, discount: totals.values.discount ?? null, total: totals.values.total ?? null, checkoutMarker: finalRead.values.marker !== null };
      ev("verifier.dom_read", { cartStatus: cartRead.status, ...dom });
    } catch (e) {
      // Without the browser read the run cannot be called complete, however good the server state looks.
      ev("verifier.dom_read_failed", { error: (e as Error).message });
      status = /worker_timeout|Timeout \d+ms exceeded/.test((e as Error).message) ? "timed_out" : "failed";
      error = error ?? `verification could not read the browser: ${(e as Error).message.slice(0, 120)}`;
    }
    if (stopReason) throw new Error(stopReason === "timed_out" ? "wall clock limit reached" : "cancelled by operator");
    const netlog = await worker.call<{ entries: unknown[] }>("netlog").catch(() => ({ entries: [] }));
    await put("worker-network.json", JSON.stringify(netlog.entries, null, 2));
  } catch (e) {
    const hung = /worker_timeout|Timeout \d+ms exceeded/.test((e as Error).message);
    status = stopReason ?? (hung ? "timed_out" : "failed");
    error = stopReason === "timed_out" ? "wall clock limit reached" : stopReason === "cancelled" ? "cancelled by operator"
      : hung ? `browser stopped responding (${(e as Error).message.slice(0, 80)})` : (e as Error).message.slice(0, 300);
    ev("run.error", { error });
  } finally {
    // 5. Teardown is unconditional and confirmed.
    clearTimeout(stopTimer);
    if (worker) {
      cleanup = await worker.destroy();
      await put("worker-events.json", JSON.stringify(worker.events, null, 2));
    }
    await new Promise<void>((r) => gateway.close(() => r()));
    if (socketDir) await rm(socketDir, { recursive: true, force: true });
    ev("cleanup.done", cleanup);
  }

  // 6. Trusted server-side state, straight from the storefront (never via the worker).
  let server: SessionState | null = null;
  try {
    const r = await fetch(`${cfg.storefront.trustedBase}/sessions/${sid}`);
    if (r.ok) server = (await r.json()) as SessionState;
  } catch { /* stays null -> INCONCLUSIVE */ }
  await put("server-state.json", JSON.stringify(server, null, 2));

  const allowedOffScope = gatewayEvents.filter((g) => g.decision === "allow" && !new URL(g.target).pathname.startsWith(basePath)).length;
  await put("gateway.jsonl", gatewayEvents.map((g) => JSON.stringify(g)).join("\n"));
  await put("model-calls.jsonl", modelCalls.map((m) => JSON.stringify(m)).join("\n"));
  await put("policy-decisions.jsonl", steps.map((s) => JSON.stringify({ step: s.step, proposal: s.proposal, decision: s.policy, dispatched: s.dispatched, result: s.result })).join("\n"));
  await put("cleanup.json", JSON.stringify({ ...cleanup, socketRemoved: socketDir !== null }, null, 2));

  // Evidence integrity: re-read every file and compare with the hash recorded at write time.
  let hashesMatch = true;
  for (const [rel, h] of Object.entries(files)) {
    if (sha256(await readFile(join(dir, rel))) !== h) hashesMatch = false;
  }

  const report = verify({
    runId,
    spec,
    dom,
    server,
    policy: {
      dispatched: steps.filter((s) => s.dispatched).length,
      dispatchedWithoutAllow: steps.filter((s) => s.dispatched && s.policy.decision !== "allow" && !s.approved).length,
      denied: steps.filter((s) => s.policy.decision === "deny").length,
      needsApproval: steps.filter((s) => s.policy.decision === "needs_approval").length,
      approvalsGranted,
    },
    network: { measured: true, deniedRequests: gatewayEvents.filter((g) => g.decision === "deny").length, allowedOffScope },
    evidence: { screenshots: screenshotCount, hashesMatch },
    cleanup,
  });
  if (status !== "completed" && report.verdict === "PASS") report.verdict = "INCONCLUSIVE"; // a broken run never reports PASS
  await put("assertions.json", JSON.stringify(report, null, 2));

  const isolation = cfg.worker.kind === "sandbox"
    ? { runtime: cfg.worker.limits.runtime, network: "none + per-run gateway socket", chromiumSandbox: !cfg.worker.limits.chromiumNoSandbox, image: cfg.worker.limits.image, hostObserved }
    : { runtime: "none (LOCAL: plain child process, NOT isolated)", network: "proxy to per-run gateway on loopback", chromiumSandbox: true, image: null };
  const meta = {
    runId, tier: cfg.tier, codeSha: cfg.codeSha, specSha256: spec.specSha256, deployment: cfg.deployment, mode: cfg.mode,
    model: { kind: cfg.planner.kind, requested: cfg.planner.model, responseModels: [...new Set(modelCalls.map((m) => m.responseModel).filter(Boolean))] },
    startedAt: events[0]?.at, finishedAt: new Date().toISOString(), status, error, verdict: report.verdict, outcomes: report.outcomes,
    limits: { maxSteps, wallClockMs: cfg.wallClockMs ?? 120_000, maxModelCalls, maxTotalTokens }, isolation,
    tokens: { total: modelCalls.reduce((n, m) => n + (m.usage?.totalTokens ?? 0), 0), calls: modelCalls.length },
  };
  // The report and event log are what people read, so they are sealed too.
  await put("events.jsonl", events.map((e) => JSON.stringify(e)).join("\n"));
  await put("report.md", renderReport(meta, report, steps, spec));
  const manifest = { ...meta, files };
  const manifestText = JSON.stringify(manifest, null, 2);
  await writeFile(join(dir, "manifest.json"), manifestText);
  const manifestSha256 = sha256(manifestText);
  return { runId, status, verdict: report.verdict, report, evidenceDir: dir, steps: steps.length, error, manifestSha256 };
}

function renderReport(m: Record<string, unknown> & { runId: string; tier: string }, r: VerifierReport, steps: StepRecord[], spec: FrozenSpec): string {
  const rows = r.checks.map((c) => `| ${c.name} | ${c.outcome} | ${c.expected === undefined ? "" : JSON.stringify(c.expected)} | ${c.observed === undefined ? "" : JSON.stringify(c.observed)} |`).join("\n");
  const stepRows = steps.map((s) => `| ${s.step} | \`${JSON.stringify(s.proposal)?.slice(0, 90)}\` | ${s.policy.decision} (${s.policy.rule}) | ${s.dispatched ? "yes" : "no"} | ${(s.result ?? "").slice(0, 80)} |`).join("\n");
  return `# ProofOps run ${m.runId}

- **Tier:** ${m.tier}${m.tier.startsWith("LOCAL") ? " (local development run: not Vultr-hosted, not isolated)" : ""}
- **Verdict:** ${r.verdict}. Commerce ${r.outcomes.commerce}, permissions ${r.outcomes.permissions}, containment ${r.outcomes.containment}, evidence ${r.outcomes.evidence}, cleanup ${r.outcomes.cleanup}
- **Fixture:** ${spec.fixtureVersion}, mode \`${spec.mode}\`, rules ${spec.rulesVersion}, spec sha256 \`${spec.specSha256.slice(0, 16)}…\`
- **Code:** \`${String(m.codeSha)}\`, deployment ${String(m.deployment)}

## Assertions (expected values frozen before the first model call)
| Check | Outcome | Expected | Observed |
|---|---|---|---|
${rows}

## Steps (model proposes, policy decides)
| # | Proposal | Policy | Dispatched | Result |
|---|---|---|---|---|
${stepRows}

## Reproduce
Create a \`${spec.mode}\` storefront session, add SKU ${spec.sku} ×${spec.quantity}, apply ${spec.coupon}, open the cart: expected total ${spec.expected.totalCents} cents.
`;
}
