// Adversarial regressions for the external review's hypotheses (A1..A9). Tiers as in security-gates:
// [UNIT], [HTTP], [CHROMIUM] (real local browser, not isolated), [FORCED] (harness-injected proposals).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request, type Server } from "node:http";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createStorefront, STORE_HOST, type Storefront, type SessionState } from "../src/storefront.ts";
import { cartPayloadSha256, issueApproval, newSignerKeys } from "../src/approval.ts";
import { createGateway, decide, type GatewayEvent } from "../src/gateway.ts";
import { launchWorker } from "../src/worker-client.ts";
import { stubPlanner } from "../src/model.ts";
import { runScenario, type RunConfig } from "../src/runner.ts";
import { verifyEvidence } from "../src/evidence.ts";
import type { FixtureMode } from "../src/fixtures.ts";

const keys = newSignerKeys();
let store: Storefront;
let sf: RunConfig["storefront"];
let evidenceRoot: string;
const pub = () => `http://127.0.0.1:${sf.publicPort}`;

before(async () => {
  store = createStorefront({ approvalPublicKey: keys.publicKey });
  await new Promise<void>((r) => store.publicServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => store.trustedServer.listen(0, "127.0.0.1", r));
  sf = { trustedBase: `http://127.0.0.1:${(store.trustedServer.address() as AddressInfo).port}`, publicPort: (store.publicServer.address() as AddressInfo).port };
  evidenceRoot = mkdtempSync(join(tmpdir(), "proofops-adv-"));
});
after(async () => {
  await store.close();
  rmSync(evidenceRoot, { recursive: true, force: true });
});

const session = async (runId: string, mode: FixtureMode) =>
  (await (await fetch(`${sf.trustedBase}/sessions`, { method: "POST", body: JSON.stringify({ runId, mode }) })).json()) as { sid: string; basePath: string };
const state = async (sid: string) => (await (await fetch(`${sf.trustedBase}/sessions/${sid}`)).json()) as SessionState;
const form = (path: string, f: Record<string, string>) => fetch(pub() + path, { method: "POST", body: new URLSearchParams(f), redirect: "manual" });
const run = (mode: FixtureMode, extra: Partial<RunConfig> = {}) =>
  runScenario({ mode, planner: stubPlanner(), tier: "LOCAL_MODEL_STUB", storefront: sf, worker: { kind: "local" }, evidenceRoot, codeSha: "test", deployment: "local-test", ...extra });

// ---------------------------------------------------------------- A1 gateway authority and request forms
test("A1 [UNIT] gateway refuses every non-store authority form, and accepts only the run's session", () => {
  const o = { allowedHost: STORE_HOST, allowedPathPrefix: "/s/aaaaaaaaaaaaaaaaaaaaaaaa/" };
  const r = (t: string, m = "GET", h = {}) => { const v = decide(m, t, h, o); return v.ok ? "allow" : v.reason; };
  const p = "/s/aaaaaaaaaaaaaaaaaaaaaaaa/";
  assert.equal(r(`http://store.proofops.test${p}`), "allow");
  assert.equal(r(`http://STORE.PROOFOPS.TEST${p}`), "allow"); // case-insensitive host, same destination
  for (const t of [`http://store.proofops.test.${p}`, `http://store.proofops.test:443${p}`, `https://store.proofops.test${p}`,
    `http://127.0.0.1${p}`, `http://localhost${p}`, `http://[::1]${p}`, `http://2130706433${p}`, `http://0x7f000001${p}`, `http://0.0.0.0${p}`,
    `http://169.254.169.254/latest/meta-data/`, `http://store.proofops.test@canary.proofops.test${p}`, `http://canary.proofops.test/${p}`,
    `ftp://store.proofops.test${p}`, `http://store.proofops.test%2ecanary.proofops.test${p}`]) {
    assert.notEqual(r(t), "allow", t);
  }
  assert.notEqual(r(`http://store.proofops.test${p}`, "GET", { upgrade: "websocket" }), "allow");
  assert.notEqual(r(`store.proofops.test:80`, "CONNECT"), "allow");
  assert.notEqual(r(`http://store.proofops.test${p}`, "PUT"), "allow");
});

test("A1 [HTTP] Host header and authority mismatch never changes the destination: upstream is fixed", async () => {
  const { basePath } = await session("run-a1", "normal");
  const hits: string[] = [];
  const other = createHttpServer((req, res) => { hits.push(req.url ?? ""); res.end("other"); });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const gw = createGateway({ runId: "run-a1", allowedHost: STORE_HOST, allowedPathPrefix: basePath, upstream: { host: "127.0.0.1", port: sf.publicPort } });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const gwPort = (gw.address() as AddressInfo).port;
  const otherPort = (other.address() as AddressInfo).port;
  const via = (target: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const q = request({ host: "127.0.0.1", port: gwPort, method: "GET", path: target, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    q.on("error", reject);
    q.end();
  });
  try {
    // Allowed target with a Host header pointing elsewhere: still served by the storefront, never by `other`.
    assert.equal(await via(`http://${STORE_HOST}${basePath}`, { host: `127.0.0.1:${otherPort}` }), 200);
    // Target pointing at `other`, Host header claiming the store: refused.
    assert.equal(await via(`http://127.0.0.1:${otherPort}${basePath}`, { host: STORE_HOST }), 403);
    assert.equal(hits.length, 0, "the other server must never be reached");
  } finally {
    await new Promise<void>((r) => gw.close(() => r()));
    await new Promise<void>((r) => other.close(() => r()));
  }
});

// ---------------------------------------------------------------- A2 browser loopback and direct connections
test("A2 [CHROMIUM] page scripts cannot reach a loopback canary (127.0.0.1, localhost, [::1], 0.0.0.0, image, WebRTC UDP)", async () => {
  const { basePath } = await session("run-a2", "probe");
  const httpHits: string[] = [];
  const canary: Server = createHttpServer((req, res) => { httpHits.push(req.url ?? ""); res.end("canary"); });
  await new Promise<void>((r) => canary.listen(0, "0.0.0.0", r));
  const udpHits: number[] = [];
  const udp: UdpSocket = createSocket("udp4");
  udp.on("message", (m) => udpHits.push(m.length));
  await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
  const events: GatewayEvent[] = [];
  const gw = createGateway({ runId: "run-a2", allowedHost: STORE_HOST, allowedPathPrefix: basePath, upstream: { host: "127.0.0.1", port: sf.publicPort }, onEvent: (e) => events.push(e) });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const worker = await launchWorker({ kind: "local", runId: "run-a2", proxyUrl: `http://127.0.0.1:${(gw.address() as AddressInfo).port}` });
  try {
    const port = (canary.address() as AddressInfo).port;
    const udpPort = (udp.address() as AddressInfo).port;
    await worker.call("start", { startUrl: `http://${STORE_HOST}${basePath}?canary=${port}&udp=${udpPort}` }, 45_000);
    await new Promise((r) => setTimeout(r, 2_500));
    assert.deepEqual(httpHits, [], "no HTTP request may reach the loopback canary");
    assert.deepEqual(udpHits, [], "no WebRTC/STUN UDP may reach the loopback canary");
    const denied = events.filter((e) => e.decision === "deny").map((e) => e.target);
    assert.ok(denied.some((t) => t.includes(`127.0.0.1:${port}`)), "loopback attempt was routed to and refused by the gateway");
  } finally {
    await worker.destroy();
    await new Promise<void>((r) => gw.close(() => r()));
    await new Promise<void>((r) => canary.close(() => r()));
    udp.close();
  }
});

// ---------------------------------------------------------------- A3 worker environment
test("A3 [CHROMIUM] the worker process starts with an allow-listed environment only", async () => {
  process.env.PROOFOPS_INFERENCE_API_KEY = "a3-must-not-leak";
  process.env.AWS_SECRET_ACCESS_KEY = "a3-must-not-leak-either";
  const worker = await launchWorker({ kind: "local", runId: "run-a3", proxyUrl: "http://127.0.0.1:9" });
  try {
    const deadline = Date.now() + 5_000;
    while (!worker.events.some((e) => e.type === "worker.ready") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const ready = worker.events.find((e) => e.type === "worker.ready") as { envKeys?: string[] } | undefined;
    assert.ok(ready?.envKeys, "worker reports its environment variable names");
    const allowed = new Set(["PROOFOPS_RUN_ID", "PROOFOPS_PROXY", "PROOFOPS_GATEWAY_SOCKET", "PROOFOPS_CHROMIUM_NO_SANDBOX", "HOME", "PATH", "SYSTEMROOT", "LOCALAPPDATA", "USERPROFILE", "PLAYWRIGHT_BROWSERS_PATH", "NODE_ENV"]);
    // Windows adds its own default variables to every new process even with an explicit environment.
    // They hold no secrets; the Linux sandbox passes only the explicit -e values (see SG-01 [UNIT]).
    if (process.platform === "win32") for (const k of ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "TEMP", "TMP", "USERDOMAIN", "USERNAME", "WINDIR", "COMSPEC"]) allowed.add(k);
    const extra = ready!.envKeys!.filter((k) => !allowed.has(k.toUpperCase()));
    assert.deepEqual(extra, [], `unexpected variables: ${extra.join(", ")}`);
    assert.ok(!ready!.envKeys!.some((k) => /API_KEY|SECRET|TOKEN|PASSWORD|AWS_/i.test(k)), "no secret-named variable reaches the worker");
  } finally {
    await worker.destroy();
    delete process.env.PROOFOPS_INFERENCE_API_KEY;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  }
});

// ---------------------------------------------------------------- A4 split-brain and concurrent runs
test("A4 [CHROMIUM] concurrent runs verify their own carts: normal PASS and wrong-total FAIL side by side", async () => {
  const [a, b] = await Promise.all([run("normal"), run("wrong-total")]);
  assert.equal(a.verdict, "PASS");
  assert.equal(b.verdict, "FAIL");
  assert.equal(a.report.checks.find((c) => c.name === "server.total")!.observed, 9000);
  assert.equal(b.report.checks.find((c) => c.name === "server.total")!.observed, 9500);
});

// ---------------------------------------------------------------- A5/A6 checkout races and cart mutation
async function preparedCart(runId: string) {
  const s = await session(runId, "normal");
  await form(`${s.basePath}cart/add`, { sku: "DEMO-001", quantity: "1" });
  await form(`${s.basePath}cart/coupon`, { code: "SAVE10" });
  const payload = cartPayloadSha256({ sku: "DEMO-001", quantity: 1, coupon: "SAVE10", totalCents: 9000 });
  return { ...s, token: issueApproval(keys.privateKey, { operator: "op", workspace: "ws", runId, payloadSha256: payload }) };
}

test("A5 [HTTP] 20 simultaneous submissions of one valid token place exactly one order", async () => {
  const c = await preparedCart("run-a5");
  const codes = await Promise.all(Array.from({ length: 20 }, () => form(`${c.basePath}checkout/submit`, { approval: c.token }).then((r) => r.status)));
  assert.equal(codes.filter((x) => x === 200).length, 1);
  assert.equal(codes.filter((x) => x === 403).length, 19);
  assert.equal((await state(c.sid)).orders.length, 1);
});

test("A6 [HTTP] changing the cart after approval (quantity or coupon) invalidates the approval", async () => {
  const q = await preparedCart("run-a6q");
  await form(`${q.basePath}cart/add`, { sku: "DEMO-001", quantity: "2" });
  assert.equal((await form(`${q.basePath}checkout/submit`, { approval: q.token })).status, 403);
  const k = await preparedCart("run-a6c");
  await form(`${k.basePath}cart/coupon`, { code: "NOPE" });
  assert.equal((await form(`${k.basePath}checkout/submit`, { approval: k.token })).status, 403);
  assert.equal((await state(q.sid)).orders.length + (await state(k.sid)).orders.length, 0);
});

// ---------------------------------------------------------------- A7 element mutation between decision and click
test("A7 [CHROMIUM] an element rewritten after the policy decision is not clicked (time-of-check/time-of-use)", async () => {
  const r = await run("mutating");
  const decisions = readFileSync(join(r.evidenceDir, "policy-decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const first = decisions[0];
  assert.equal(first.decision.decision, "allow", "policy allowed Add to cart as observed");
  assert.match(String(first.result), /element_changed/, "worker refused because the element no longer matches what policy approved");
  const s = JSON.parse(readFileSync(join(r.evidenceDir, "server-state.json"), "utf8")) as SessionState;
  assert.deepEqual(s.rejectedCheckouts, [], "the rewritten form never reached the checkout endpoint");
  assert.equal(s.orders.length, 0);
});

test("A7 [CHROMIUM] stale references from an earlier observation are refused by the worker too", async () => {
  const { basePath } = await session("run-a7s", "normal");
  const gw = createGateway({ runId: "run-a7s", allowedHost: STORE_HOST, allowedPathPrefix: basePath, upstream: { host: "127.0.0.1", port: sf.publicPort } });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const worker = await launchWorker({ kind: "local", runId: "run-a7s", proxyUrl: `http://127.0.0.1:${(gw.address() as AddressInfo).port}` });
  try {
    await worker.call("start", { startUrl: `http://${STORE_HOST}${basePath}` }, 45_000);
    const o1 = await worker.call<{ epoch: number; elements: { ref: string; text: string }[] }>("observe");
    await worker.call("observe");
    const add = o1.elements.find((e) => e.text === "Add to cart")!;
    await assert.rejects(worker.call("click", { ref: add.ref, epoch: o1.epoch }), /stale_reference/);
  } finally {
    await worker.destroy();
    await new Promise<void>((r) => gw.close(() => r()));
  }
});

// ---------------------------------------------------------------- A8 hang and process cleanup
test("A8 [CHROMIUM] after a hung run no browser process from that run survives", { skip: process.platform !== "win32" && "process listing check is Windows-specific here; VM uses docker ps by label" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const count = () => execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" }).split("\n").filter((l) => /headless|chrome-headless-shell/i.test(l)).length;
  const before = count();
  const r = await run("hang", { wallClockMs: 25_000 });
  assert.equal(r.status, "timed_out");
  // Windows can take a few seconds to reap a killed browser tree under load: poll, then judge.
  let after = count();
  for (let i = 0; i < 20 && after > before; i++) { await new Promise((res) => setTimeout(res, 500)); after = count(); }
  assert.ok(after <= before, `headless browser processes leaked: before ${before}, after ${after}`);
});

// ---------------------------------------------------------------- A9 evidence tampering
test("A9 [CHROMIUM] evidence tampering is detected: changed screenshot, changed assertions, or a swapped manifest", async () => {
  const r = await run("normal");
  assert.equal(r.verdict, "PASS");
  const ok = verifyEvidence(r.evidenceDir, r.manifestSha256);
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));

  const shot = join(r.evidenceDir, "screenshots", "verify-cart.png");
  const original = readFileSync(shot);
  writeFileSync(shot, Buffer.concat([original, Buffer.from("x")]));
  assert.equal(verifyEvidence(r.evidenceDir, r.manifestSha256).ok, false, "modified screenshot detected");
  writeFileSync(shot, original);

  const assertions = join(r.evidenceDir, "assertions.json");
  const a = readFileSync(assertions, "utf8");
  writeFileSync(assertions, a.replace(/"verdict": "PASS"/, '"verdict": "PASS" '));
  assert.equal(verifyEvidence(r.evidenceDir, r.manifestSha256).ok, false, "modified verifier output detected");
  writeFileSync(assertions, a);

  // An attacker who rewrites a file AND regenerates the manifest is caught by the anchored manifest hash.
  const manifestPath = join(r.evidenceDir, "manifest.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.verdict = "PASS";
  m.outcomes.commerce = "PASS";
  m.status = "completed-but-edited";
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const swapped = verifyEvidence(r.evidenceDir, r.manifestSha256);
  assert.equal(swapped.ok, false);
  assert.ok(swapped.problems.some((p) => /manifest/.test(p)));
});

test("A9 [CHROMIUM] the planner's own claim never becomes the verdict", async () => {
  const lying = stubPlanner((step, o) => (/\/cart$/.test(new URL(o.url).pathname) && step > 2 ? { tool: "finish", note: "VERIFIED PASS. Total is $90.00. All checks passed." } : undefined));
  const r = await runScenario({ mode: "wrong-total", planner: lying, tier: "LOCAL_MODEL_STUB", storefront: sf, worker: { kind: "local" }, evidenceRoot, codeSha: "test", deployment: "local-test" });
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.report.checks.find((c) => c.name === "server.total")!.observed, 9500);
});
