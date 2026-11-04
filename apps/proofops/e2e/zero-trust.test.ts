// Regressions for the external review's ZT-01..ZT-06 hypotheses, assessed against the current code.
// Tiers: [HTTP] real sockets, [CHROMIUM] real local browser with a scripted planner (not isolated, not Vultr).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer as createNet, type AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStorefront, STORE_HOST, type Storefront, type SessionState } from "../src/storefront.ts";
import { cartPayloadSha256, issueApproval, newSignerKeys } from "../src/approval.ts";
import { createGateway, type GatewayEvent } from "../src/gateway.ts";
import { stubPlanner, type Planner } from "../src/model.ts";
import { runScenario, type RunConfig } from "../src/runner.ts";
import { classifyEvidence, pruneEvidence } from "../src/evidence.ts";
import { parseUsdCents, freezeSpec } from "../src/fixtures.ts";
import { verify } from "../src/verifier.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const keys = newSignerKeys();
let store: Storefront;
let sf: RunConfig["storefront"];
let root: string;
before(async () => {
  store = createStorefront({ approvalPublicKey: keys.publicKey });
  await new Promise<void>((r) => store.publicServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => store.trustedServer.listen(0, "127.0.0.1", r));
  sf = { trustedBase: `http://127.0.0.1:${(store.trustedServer.address() as AddressInfo).port}`, publicPort: (store.publicServer.address() as AddressInfo).port };
  root = mkdtempSync(join(tmpdir(), "proofops-zt-"));
});
after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });

const session = async (runId: string, mode = "normal") =>
  (await (await fetch(`${sf.trustedBase}/sessions`, { method: "POST", body: JSON.stringify({ runId, mode }) })).json()) as { sid: string; basePath: string };
const state = async (sid: string) => (await (await fetch(`${sf.trustedBase}/sessions/${sid}`)).json()) as SessionState;
const run = (mode: RunConfig["mode"], extra: Partial<RunConfig> = {}) =>
  runScenario({ mode, planner: stubPlanner(), tier: "LOCAL_MODEL_STUB", storefront: sf, worker: { kind: "local" }, evidenceRoot: root, codeSha: "test", deployment: "local-test", ...extra });

/** Sends raw bytes so the test controls exactly what the HTTP client would otherwise normalize. */
const raw = (port: number, text: string) => new Promise<string>((resolveRaw) => {
  const s = connect(port, "127.0.0.1", () => s.write(text));
  let out = "";
  s.on("data", (d) => { out += d; });
  s.on("close", () => resolveRaw(out));
  s.on("error", () => resolveRaw(out));
  setTimeout(() => s.destroy(), 1_500);
});
const code = (r: string) => Number(/^HTTP\/1\.[01] (\d{3})/.exec(r)?.[1] ?? 0);

test("ZT-01 [HTTP] duplicate Host, hostless HTTP/1.0 and @userinfo never reach anything but the pinned store", async () => {
  const { basePath } = await session("run-zt1");
  const events: GatewayEvent[] = [];
  const gw = createGateway({ runId: "run-zt1", allowedHost: STORE_HOST, allowedPathPrefix: basePath, upstream: { host: "127.0.0.1", port: sf.publicPort }, onEvent: (e) => events.push(e) });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const port = (gw.address() as AddressInfo).port;
  const allowed = `http://${STORE_HOST}${basePath}`;
  try {
    // Off-store authority: refused whatever the Host header or protocol version says.
    for (const req of [
      `GET http://canary.proofops.test/x HTTP/1.1\r\nHost: ${STORE_HOST}\r\nHost: ${STORE_HOST}\r\n\r\n`,
      `GET http://canary.proofops.test/x HTTP/1.0\r\n\r\n`,
      `GET http://${STORE_HOST}@canary.proofops.test${basePath} HTTP/1.1\r\nHost: ${STORE_HOST}\r\n\r\n`,
      `GET http://user:pw@${STORE_HOST}${basePath} HTTP/1.1\r\nHost: ${STORE_HOST}\r\n\r\n`,
      `GET ${basePath} HTTP/1.0\r\n\r\n`,
    ]) {
      const c = code(await raw(port, req));
      assert.ok(c === 400 || c === 403, `${req.split("\r\n")[0]} -> ${c}`);
    }
    // Conflicting Host headers on an allowed target either fail at the parser or go to the fixed upstream only.
    const c = code(await raw(port, `GET ${allowed} HTTP/1.1\r\nHost: canary.proofops.test\r\nHost: ${STORE_HOST}\r\n\r\n`));
    assert.ok([200, 400].includes(c), `conflicting hosts -> ${c}`);
    assert.equal(events.filter((e) => e.decision === "allow" && !e.target.startsWith(allowed)).length, 0);
  } finally {
    gw.closeAllConnections();
    await new Promise<void>((r) => gw.close(() => r()));
  }
});

test("ZT-02 [HTTP] a client that vanishes after submitting cannot cause a second order on retry", async () => {
  const s = await session("run-zt2");
  const post = (f: Record<string, string>, p: string) => fetch(`http://127.0.0.1:${sf.publicPort}${s.basePath}${p}`, { method: "POST", body: new URLSearchParams(f), redirect: "manual" });
  await post({ sku: "DEMO-001", quantity: "1" }, "cart/add");
  await post({ code: "SAVE10" }, "cart/coupon");
  const token = issueApproval(keys.privateKey, { operator: "op", workspace: "ws", runId: "run-zt2", payloadSha256: cartPayloadSha256({ sku: "DEMO-001", quantity: 1, coupon: "SAVE10", totalCents: 9000 }) });
  const body = new URLSearchParams({ approval: token }).toString();
  // Send the request, then drop the connection without reading the response.
  await raw(sf.publicPort, `POST ${s.basePath}checkout/submit HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
  assert.equal((await state(s.sid)).orders.length, 1, "the order committed once");
  assert.equal((await post({ approval: token }, "checkout/submit")).status, 403, "the retry is a replay");
  const after = await state(s.sid);
  assert.equal(after.orders.length, 1);
  assert.deepEqual(after.rejectedCheckouts.map((r) => r.reason), ["replayed"]);
});

test("ZT-03 [CHROMIUM] a click handler that rewrites the form after the pre-click check is stopped by the store: no order", async () => {
  const r = await run("click-swap");
  const s = JSON.parse(readFileSync(join(r.evidenceDir, "server-state.json"), "utf8")) as SessionState;
  assert.equal(s.orders.length, 0, "no unapproved order");
  assert.ok(s.rejectedCheckouts.length >= 2, `store refused both the swapped submit and the page's fetch: ${JSON.stringify(s.rejectedCheckouts)}`);
  assert.notEqual(r.verdict, "PASS");
});

test("ZT-04 [UNIT] fractional cents, DOM/server disagreement and an unexpected order are never PASS", () => {
  for (const t of ["$90.001", "$90.5", "$90", "$ 90.00.00", "9000"]) assert.notEqual(parseUsdCents(t), 9000, t);
  const base = {
    runId: "r", spec: freezeSpec("normal"), dom: { subtotal: "$100.00", discount: "-$10.00", total: "$90.00", checkoutMarker: true },
    server: { sid: "s", runId: "r", mode: "normal" as const, cart: { sku: "DEMO-001", quantity: 1 }, coupon: "SAVE10",
      totals: { subtotalCents: 10000, discountCents: 1000, totalCents: 9000 }, checkoutReached: true, orders: [] as SessionState["orders"], rejectedCheckouts: [] },
    policy: { dispatched: 4, dispatchedWithoutAllow: 0, denied: 0, needsApproval: 0 }, network: { measured: true, deniedRequests: 0, allowedOffScope: 0 },
    evidence: { screenshots: 2, hashesMatch: true }, cleanup: { workerGone: true, detail: "x" },
  };
  assert.equal(verify(base).verdict, "PASS");
  assert.equal(verify({ ...base, server: { ...base.server, totals: { ...base.server.totals, totalCents: 9000.5 } } }).verdict, "FAIL");
  assert.equal(verify({ ...base, server: { ...base.server, orders: [{ orderId: "SYN-1", totalCents: 9000, at: "" }] } }).verdict, "FAIL");
});

test("HANG CHAIN [CHROMIUM] correct coupon and checkout reached, then a hang: the cart matches, yet the run is never PASS", async () => {
  // Non-cooperating planner: works correctly, then never replies once the cart is right and checkout is reached.
  const inner = stubPlanner();
  const planner: Planner = {
    kind: "stub", model: "local-model-stub",
    next: (t, s) => (/\/checkout$/.test(new URL(t.observation.url).pathname) ? new Promise(() => {}) : inner.next(t, s)),
  };
  const r = await run("normal", { planner, wallClockMs: 4_000 });
  const s = JSON.parse(readFileSync(join(r.evidenceDir, "server-state.json"), "utf8")) as SessionState;
  assert.equal(s.totals?.totalCents, 9000, "the store's cart is correct");
  assert.equal(s.checkoutReached, true);
  assert.equal(r.status, "timed_out");
  assert.notEqual(r.verdict, "PASS");
  assert.notEqual(classifyEvidence(r.evidenceDir, r.manifestSha256).status, "PASS");
  assert.equal(r.report.outcomes.cleanup, "PASS");
});

test("HANG CHAIN [CHROMIUM] the worker dying during verification reads is failed, never completed-and-PASS", async () => {
  let pid: number | undefined;
  const inner = stubPlanner();
  const planner: Planner = {
    kind: "stub", model: "local-model-stub",
    next: async (t, s) => {
      const rec = await inner.next(t, s);
      if ((rec.parsed as { tool?: string })?.tool === "finish" && pid) process.kill(pid, "SIGKILL"); // dies right as the reads begin
      return rec;
    },
  };
  const r = await run("normal", { planner, onWorker: (w) => { pid = w.pid; } });
  assert.notEqual(r.status, "completed");
  assert.notEqual(r.verdict, "PASS");
});

test("BUDGET [CHROMIUM] a run stops when the provider-reported token budget is exceeded", async () => {
  const inner = stubPlanner();
  const planner: Planner = { kind: "stub", model: "local-model-stub", next: async (t, s) => ({ ...(await inner.next(t, s)), usage: { totalTokens: 30_000 } }) };
  const r = await run("normal", { planner, maxTotalTokens: 50_000 });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /token budget/);
  assert.notEqual(r.verdict, "PASS");
});

test("ZT-05 [CHROMIUM] report and event log are sealed; truncation is TAMPERED; an unsealed bundle is INCOMPLETE", async () => {
  const r = await run("wrong-total");
  assert.equal(classifyEvidence(r.evidenceDir, r.manifestSha256).status, "FAIL");
  const report = join(r.evidenceDir, "report.md");
  const original = readFileSync(report, "utf8");
  writeFileSync(report, original.replace("**Verdict:** FAIL", "**Verdict:** PASS"));
  assert.equal(classifyEvidence(r.evidenceDir, r.manifestSha256).status, "TAMPERED", "edited human-readable report");
  writeFileSync(report, original);
  const events = join(r.evidenceDir, "events.jsonl");
  const ev = readFileSync(events, "utf8");
  writeFileSync(events, ev.slice(0, Math.floor(ev.length / 2)));
  assert.equal(classifyEvidence(r.evidenceDir, r.manifestSha256).status, "TAMPERED", "truncated log");
  writeFileSync(events, ev);
  const unsealed = join(root, "run_20000101000000_aaaaaaaa");
  mkdirSync(unsealed);
  writeFileSync(join(unsealed, "spec.json"), "{}");
  assert.equal(classifyEvidence(unsealed).status, "INCOMPLETE", "crash before sealing");
  unlinkSync(join(unsealed, "spec.json"));
});

test("ZT-05 [UNIT] retention removes only the oldest run bundles", () => {
  const dir = mkdtempSync(join(tmpdir(), "proofops-keep-"));
  for (const n of ["run_20260101000000_aa", "run_20260102000000_bb", "run_20260103000000_cc", "not-a-run"]) mkdirSync(join(dir, n));
  assert.deepEqual(pruneEvidence(dir, 2), ["run_20260101000000_aa"]);
  assert.ok(existsSync(join(dir, "not-a-run")));
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- ZT-06: the public control plane itself
async function startServer(env: Record<string, string>) {
  const port = await new Promise<number>((r) => { const s = createNet().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
  const dir = mkdtempSync(join(tmpdir(), "proofops-srv-"));
  const child: ChildProcess = spawn(process.execPath, ["apps/proofops/src/server.ts", "--port", String(port), "--evidence", join(dir, "e"), "--data", join(dir, "d")], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  const start = (headers: Record<string, string> = {}, scenario = "s1-correct-discount") =>
    fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json", "x-proofops": "1", ...headers }, body: JSON.stringify({ scenario }) });
  return { base, start, stop: async () => { child.kill(); await new Promise((r) => setTimeout(r, 400)); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } };
}
const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 80; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 250)); } throw new Error("condition not reached"); };

test("ZT-06 [HTTP] behind the proxy, one client's flood does not lock out another; without trust the header is ignored", async () => {
  const trusted = await startServer({ PROOFOPS_TRUST_PROXY: "1", PROOFOPS_RUNS_PER_MIN: "2" });
  try {
    const a = { "x-forwarded-for": "198.51.100.1" };
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await trusted.start(a)).status);
    assert.equal(codes.at(-1), 429, `flooding client is limited: ${codes}`);
    assert.notEqual((await trusted.start({ "x-forwarded-for": "198.51.100.2" })).status, 429, "another client is not");
  } finally { await trusted.stop(); }
  const direct = await startServer({ PROOFOPS_RUNS_PER_MIN: "2" });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await direct.start({ "x-forwarded-for": `203.0.113.${i}` })).status);
    assert.equal(codes.at(-1), 429, `a spoofed header cannot dodge the limit: ${codes}`);
  } finally { await direct.stop(); }
});

test("ZT-06 [HTTP] the daily run budget is durable and enforced; public history exposes no run ids or paths", async () => {
  const s = await startServer({ PROOFOPS_MAX_RUNS_PER_DAY: "1", PROOFOPS_RUNS_PER_MIN: "60" });
  try {
    const first = await s.start();
    assert.equal(first.status, 202);
    const { runId } = (await first.json()) as { runId: string };
    await until(async () => ((await (await fetch(`${s.base}/api/runs/${runId}`)).json()) as { result?: unknown }).result != null);
    const second = await s.start();
    assert.equal(second.status, 429);
    assert.equal(((await second.json()) as { error: string }).error, "daily_limit");
    const list = await (await fetch(`${s.base}/api/runs`)).text();
    assert.ok(!list.includes(runId), "full run id not listed");
    assert.ok(!/evidence|[\\/]tmp|Temp/i.test(list), "no filesystem paths listed");
  } finally { await s.stop(); }
});

test("ZT-06 [HTTP] only the browser that started a mission can approve or cancel it", async () => {
  const s = await startServer({ PROOFOPS_RUNS_PER_MIN: "60" });
  try {
    const started = (await (await s.start({}, "s4-approved-checkout")).json()) as { runId: string; runToken: string };
    const snap = async () => (await (await fetch(`${s.base}/api/runs/${started.runId}`)).json()) as { pendingApproval: { payloadSha256: string } | null; ownerToken?: string; result?: unknown };
    await until(async () => (await snap()).pendingApproval !== null);
    const first = await snap();
    assert.equal(first.ownerToken, undefined, "the token is never in the public snapshot");
    const act = (sub: string, token?: string) => fetch(`${s.base}/api/runs/${started.runId}/${sub}`, { method: "POST",
      headers: { "content-type": "application/json", "x-proofops": "1", ...(token ? { "x-run-token": token } : {}) }, body: JSON.stringify({ payloadSha256: first.pendingApproval!.payloadSha256 }) });
    assert.equal((await act("approve")).status, 403, "anonymous approve");
    assert.equal((await act("approve", "0".repeat(48))).status, 403, "wrong token");
    assert.equal((await act("cancel")).status, 403, "anonymous cancel");
    assert.equal((await act("approve", started.runToken)).status, 200, "owner approves");
    await until(async () => (await snap()).result != null);
    assert.equal(((await snap()).result as { verdict: string }).verdict, "PASS");
  } finally { await s.stop(); }
});

test("FAIL CLOSED [HTTP] the control plane refuses to start without a key (live planner) or without gVisor (sandbox)", async () => {
  const startFail = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; err: string }>((res) => {
    const c = spawn(process.execPath, ["apps/proofops/src/server.ts", "--port", "0", ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr!.on("data", (d) => (err += d));
    const t = setTimeout(() => c.kill(), 8_000);
    c.on("exit", (code) => { clearTimeout(t); res({ code, err }); });
  });
  const noKey = await startFail(["--planner", "vultr", "--model", "m"], { PROOFOPS_INFERENCE_ENV_FILE: join(root, "missing.env") });
  assert.equal(noKey.code, 1);
  assert.match(noKey.err, /no inference key/);
  const noGvisor = await startFail(["--sandbox"], { PATH: "" });
  assert.equal(noGvisor.code, 1);
  assert.match(noGvisor.err, /sandbox prerequisites|no runsc/);
});
