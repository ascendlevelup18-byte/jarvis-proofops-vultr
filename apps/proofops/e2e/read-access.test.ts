// [SECURITY] negative tests for the run-history and evidence routes. Real local control plane, scripted planner, no
// model calls. This system has no user accounts: a run id is the read capability and a per-run token guards actions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const LIVE = join(ROOT, "proof/vultr-live-20261104/runs-d14d24c");
const SEALED = "run_20261104154518_b6a586f4a0ec403d";
const UNKNOWN = "run_20260101000000_00000000";
const UI = { "x-proofops": "1", "content-type": "application/json" };
let work: string;
let main: ChildProcess;
let port: number;
let base: string;

function startServer(p: number, name: string, args: string[], env: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["apps/proofops/src/server.ts", "--port", String(p), "--evidence", join(work, `ev-${name}`), "--data", join(work, `db-${name}`), ...args], { cwd: ROOT, env: { ...process.env, PROOFOPS_READS_PER_MIN: "5000", PROOFOPS_RUNS_PER_MIN: "120", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("server did not start")), 20_000);
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("control plane on")) { clearTimeout(t); ok(child); } });
    child.once("exit", (c) => { clearTimeout(t); fail(new Error(`server exited ${c}`)); });
  });
}
/** fetch can't set Host, so header-sensitive requests use the raw client. */
function raw(p: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port: p, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    r.on("error", fail);
    r.end();
  });
}
const expectError = async (res: Response, status: number, error: string) => {
  assert.equal(res.status, status);
  assert.deepEqual(await res.json(), { error });
};
const free = () => 44000 + Math.floor(Math.random() * 3000);

before(async () => {
  work = mkdtempSync(join(tmpdir(), "proofops-access-"));
  const arch = join(work, "archive");
  cpSync(join(LIVE, SEALED), join(arch, SEALED), { recursive: true });
  cpSync(join(LIVE, "ANCHORS.txt"), join(arch, "ANCHORS.txt"));
  port = free();
  base = `http://127.0.0.1:${port}`;
  main = await startServer(port, "main", ["--archive", arch]);
});
after(async () => {
  main?.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(work, { recursive: true, force: true });
});

test("SEC-1 history: open to a direct local request, and refused with 403 for a foreign Host or a proxied request", async () => {
  assert.equal((await raw(port, "/api/history", { host: `127.0.0.1:${port}` })).status, 200);
  const refused: Record<string, string>[] = [{ host: "evil.example" }, { host: `evil.example:${port}` }, { host: `127.0.0.1:${port}`, "x-forwarded-for": "203.0.113.9" }];
  for (const headers of refused) {
    const r = await raw(port, "/api/history", headers);
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.deepEqual(JSON.parse(r.body), { error: "history_private" });
  }
});

test("SEC-2 history: behind a proxy it's closed by default, and opening it takes an explicit setting", async () => {
  const p1 = free();
  const closed = await startServer(p1, "closed", ["--archive", join(work, "archive")], { PROOFOPS_TRUST_PROXY: "1" });
  try { await expectError(await fetch(`http://127.0.0.1:${p1}/api/history`), 403, "history_private"); } finally { closed.kill(); }
  const p2 = free();
  const open = await startServer(p2, "open", ["--archive", join(work, "archive")], { PROOFOPS_TRUST_PROXY: "1", PROOFOPS_OPEN_HISTORY: "1" });
  try { assert.equal((await fetch(`http://127.0.0.1:${p2}/api/history`)).status, 200); } finally { open.kill(); }
});

test("SEC-3 ids: malformed ids get a fixed denial, and nothing reaches the file system", async () => {
  for (const q of ["a=x&b=y", `a=${SEALED}`, `a=${SEALED}&b=../../etc/passwd`, `a=${SEALED.toUpperCase()}&b=${SEALED}`, `a=${SEALED}%00&b=${SEALED}`]) {
    await expectError(await fetch(`${base}/api/compare?${q}`), 400, "bad_run_id");
  }
  for (const id of ["run_1", "RUN_20261104154518_b6a586f4a0ec403d", "run_20261104154518_B6A586F4A0EC403D", "run_20261104154518_b6a586f4a0ec403d0", "run_20261104154518_b6a586f", "..%2f..%2fetc"]) {
    await expectError(await fetch(`${base}/api/runs/${id}/summary`), 404, "not_found");
  }
});

test("SEC-4 unknown runs: every read route answers the same 404", async () => {
  for (const path of ["/summary", "/verify-evidence", "", "/stream", "/evidence/manifest.json"]) {
    await expectError(await fetch(`${base}/api/runs/${UNKNOWN}${path}`), 404, "not_found");
  }
  await expectError(await fetch(`${base}/api/compare?a=${UNKNOWN}&b=${SEALED}`), 404, "not_found");
});

test("SEC-5 evidence paths: escapes and files outside the bundle are refused", async () => {
  for (const p of ["..%2F..%2FANCHORS.txt", "..%5C..%5CANCHORS.txt", "%2e%2e/ANCHORS.txt", "../ANCHORS.txt", "..\\ANCHORS.txt", "manifest.json%00.png"]) {
    const r = await fetch(`${base}/api/runs/${SEALED}/evidence/${p}`);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(await r.text(), /run_\d{14}_[0-9a-f]+ [0-9a-f]{64}/, p);
  }
});

test("SEC-6 read routes change nothing: writes get 404 or 405", async () => {
  for (const [method, path, status] of [["POST", `/api/runs/${SEALED}/summary`, 404], ["DELETE", `/api/runs/${SEALED}/summary`, 404], ["PUT", `/api/runs/${SEALED}/evidence/manifest.json`, 404], ["POST", `/api/runs/${SEALED}/verify-evidence`, 404], ["POST", "/api/history", 405], ["DELETE", "/api/compare", 405], ["POST", "/api/trust", 405]] as const) {
    assert.equal((await fetch(base + path, { method, headers: UI, body: method === "DELETE" ? undefined : "{}" })).status, status, `${method} ${path}`);
  }
});

test("SEC-7 no cross-origin read: no CORS grant, and the security headers are on the new routes", async () => {
  for (const path of ["/api/history", `/api/runs/${SEALED}/summary`, `/api/compare?a=${SEALED}&b=${SEALED}`, "/api/trust"]) {
    const r = await raw(port, path, { host: `127.0.0.1:${port}`, origin: "https://evil.example" });
    assert.equal(r.status, 200, path);
    assert.equal(r.headers["access-control-allow-origin"], undefined, path);
    assert.equal(r.headers["x-content-type-options"], "nosniff", path);
    assert.equal(r.headers["cache-control"], "no-store", path);
    assert.match(String(r.headers["content-security-policy"]), /default-src 'self'/, path);
  }
});

test("SEC-8 reads that hash files are rate limited with 429, separately from mission starts", async () => {
  const p = free();
  const child = await startServer(p, "limit", ["--archive", join(work, "archive")], { PROOFOPS_READS_PER_MIN: "3" });
  try {
    const url = `http://127.0.0.1:${p}/api/runs/${SEALED}/summary`;
    for (let i = 0; i < 3; i++) assert.equal((await fetch(url)).status, 200);
    await expectError(await fetch(url), 429, "rate_limited");
    await expectError(await fetch(`http://127.0.0.1:${p}/api/history`), 429, "rate_limited");
    await expectError(await fetch(`http://127.0.0.1:${p}/api/runs/${SEALED}/verify-evidence`), 429, "rate_limited");
    assert.equal((await fetch(`http://127.0.0.1:${p}/api/health`)).status, 200);
  } finally { child.kill(); }
});

test("SEC-9 archived runs can't be approved, rejected or cancelled by anyone", async () => {
  for (const a of ["approve", "reject", "cancel"]) {
    await expectError(await fetch(`${base}/api/runs/${SEALED}/${a}`, { method: "POST", body: "{}" }), 403, "missing_ui_header");
    await expectError(await fetch(`${base}/api/runs/${SEALED}/${a}`, { method: "POST", headers: UI, body: "{}" }), 403, "not_run_owner");
    await expectError(await fetch(`${base}/api/runs/${SEALED}/${a}`, { method: "POST", headers: { ...UI, "x-run-token": "guess" }, body: "{}" }), 403, "not_run_owner");
  }
});

test("SEC-10 [CHROMIUM] a live run: other visitors can't act on it, it isn't summarized or listed, and nothing secret leaks afterward", async () => {
  const start = await fetch(`${base}/api/runs`, { method: "POST", headers: { ...UI, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ scenario: "s4-approved-checkout" }) });
  assert.equal(start.status, 202);
  const { runId, runToken } = (await start.json()) as { runId: string; runToken: string };
  let pending: { payloadSha256: string } | null = null;
  for (let i = 0; i < 240 && !pending; i++) {
    pending = ((await (await fetch(`${base}/api/runs/${runId}`)).json()) as { pendingApproval: { payloadSha256: string } | null }).pendingApproval;
    if (!pending) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(pending, "approval was never requested");
  const decide = (a: string, token?: string) => fetch(`${base}/api/runs/${runId}/${a}`, { method: "POST", headers: { ...UI, ...(token ? { "x-run-token": token } : {}) }, body: JSON.stringify({ payloadSha256: pending!.payloadSha256 }) });
  await expectError(await decide("approve"), 403, "not_run_owner");
  await expectError(await decide("approve", "0".repeat(48)), 403, "not_run_owner");
  await expectError(await decide("reject", "0".repeat(48)), 403, "not_run_owner");
  await expectError(await decide("cancel", "0".repeat(48)), 403, "not_run_owner");
  await expectError(await fetch(`${base}/api/runs/${runId}/summary`), 409, "run_not_finished");
  await expectError(await fetch(`${base}/api/compare?a=${runId}&b=${SEALED}`), 409, "run_not_finished");
  const listed = (await (await fetch(`${base}/api/history`)).json()) as { runId: string }[];
  assert.equal(listed.some((r) => r.runId === runId), false);
  const pub = (await (await fetch(`${base}/api/runs`)).json()) as { ref: string }[];
  assert.ok(pub.length > 0 && pub.every((r) => /^[0-9a-f]{8}$/.test(r.ref) && !runId.includes(r.ref) && !("id" in r)));

  assert.equal((await decide("approve", runToken)).status, 200);
  let summary: Record<string, unknown> | null = null;
  for (let i = 0; i < 240 && !summary; i++) {
    const r = await fetch(`${base}/api/runs/${runId}/summary`);
    if (r.status === 200) summary = (await r.json()) as Record<string, unknown>;
    else await new Promise((d) => setTimeout(d, 250));
  }
  assert.equal(summary?.outcomeClass, "verified_success");

  const texts = [JSON.stringify(summary), await (await fetch(`${base}/api/history`)).text(), await (await fetch(`${base}/api/compare?a=${runId}&b=${SEALED}`)).text(), await (await fetch(`${base}/api/trust`)).text(), await (await fetch(`${base}/api/runs`)).text()];
  const signed = /[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{80,}/;
  for (const t of texts) {
    assert.equal(t.includes(runToken), false, "owner token exposed");
    assert.doesNotMatch(t, signed, "approval token exposed");
    assert.doesNotMatch(t, /evidence_dir|INFERENCE_API_KEY|PRIVATE KEY/);
    assert.equal(t.includes(work.replaceAll("\\", "\\\\")), false, "server path exposed");
  }
  const dir = join(work, "ev-main", runId);
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk(dir).filter((x) => !x.endsWith(".png"))) {
    const t = readFileSync(f, "utf8");
    assert.equal(t.includes(runToken), false, `owner token in ${f}`);
    assert.doesNotMatch(t, signed, `approval token in ${f}`);
  }
});

test("SEC-11 [CHROMIUM] an archive with no recorded anchors shows as incomplete, in the API and on screen", async () => {
  const arch = join(work, "no-anchors");
  cpSync(join(LIVE, SEALED), join(arch, SEALED), { recursive: true });
  const p = free();
  const child = await startServer(p, "noanchor", ["--archive", arch]);
  const require = createRequire(join(ROOT, "apps/proofops/worker/package.json"));
  const browser = await (require("playwright") as any).chromium.launch();
  try {
    const s = (await (await fetch(`http://127.0.0.1:${p}/api/runs/${SEALED}/summary`)).json()) as { outcomeClass: string; evidence: { anchored: boolean } };
    assert.equal(s.outcomeClass, "incomplete_evidence");
    assert.equal(s.evidence.anchored, false);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${p}/#evidence/${SEALED}`);
    await page.waitForSelector("#evidence-detail .outcome");
    const text = await page.locator("#evidence-detail .outcome").innerText();
    assert.match(text, /Incomplete evidence/);
    assert.match(text, /no recorded anchor/);
    assert.doesNotMatch(text, /Intact|Verified success|failed as intended/);
  } finally { await browser.close(); child.kill(); }
});

test("SEC-12 [CHROMIUM] hostile text in recorded evidence stays text in the console: no script runs and no unsafe link appears", async () => {
  const arch = join(work, "hostile");
  const bundle = join(arch, SEALED);
  cpSync(join(LIVE, SEALED), bundle, { recursive: true });
  const XSS = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  const decisions = readFileSync(join(bundle, "policy-decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  decisions[0].proposal.reason = XSS;
  decisions[0].result = "javascript:window.__pwned=3";
  decisions[1].decision = { decision: "deny", rule: "<b onmouseover=window.__pwned=4>x</b>", detail: "x" };
  writeFileSync(join(bundle, "policy-decisions.jsonl"), decisions.map((d) => JSON.stringify(d)).join("\n"));
  const gw = readFileSync(join(bundle, "gateway.jsonl"), "utf8").trim().split("\n");
  gw.push(JSON.stringify({ decision: "deny", reason: XSS, method: "GET", target: "javascript:window.__pwned=5" }));
  writeFileSync(join(bundle, "gateway.jsonl"), gw.join("\n"));
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  const m = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
  for (const rel of Object.keys(m.files)) m.files[rel] = sha(readFileSync(join(bundle, rel)));
  const text = JSON.stringify(m, null, 2);
  writeFileSync(join(bundle, "manifest.json"), text);
  writeFileSync(join(arch, "ANCHORS.txt"), SEALED + " " + sha(text));
  const p = free();
  const child = await startServer(p, "hostile", ["--archive", arch]);
  const require = createRequire(join(ROOT, "apps/proofops/worker/package.json"));
  const browser = await (require("playwright") as any).chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + p + "/#evidence/" + SEALED);
    await page.waitForSelector("#evidence-detail .outcome");
    assert.ok((await page.locator("#evidence-detail").innerText()).includes("onerror="));
    const state = await page.evaluate(() => ({ pwned: (window as any).__pwned, injected: document.querySelectorAll("#evidence-detail img[src='x'], #evidence-detail script, #evidence-detail [onerror], #evidence-detail [onmouseover]").length, bad: [...document.querySelectorAll("a[href]")].filter((x) => !/^https?:$/.test((x as HTMLAnchorElement).protocol)).length }));
    assert.deepEqual(state, { pwned: undefined, injected: 0, bad: 0 });
  } finally { await browser.close(); child.kill(); }
});

test("SEC-13 a link inside a bundle can't serve a file from outside it", async (t) => {
  const arch = join(work, "linked");
  const bundle = join(arch, SEALED);
  cpSync(join(LIVE, SEALED), bundle, { recursive: true });
  const secret = join(work, "outside");
  mkdirSync(secret, { recursive: true });
  writeFileSync(join(secret, "secret.txt"), "must not be served");
  try {
    symlinkSync(secret, join(bundle, "linked"), "junction");
  } catch (e) {
    t.skip("this system refused to create the link: " + (e as Error).message);
    return;
  }
  cpSync(join(LIVE, "ANCHORS.txt"), join(arch, "ANCHORS.txt"));
  const p = free();
  const child = await startServer(p, "linked", ["--archive", arch]);
  try {
    const r = await fetch("http://127.0.0.1:" + p + "/api/runs/" + SEALED + "/evidence/linked/secret.txt");
    assert.equal(r.status, 404);
    assert.doesNotMatch(await r.text(), /must not be served/);
    assert.equal((await fetch("http://127.0.0.1:" + p + "/api/runs/" + SEALED + "/evidence/report.md")).status, 200);
  } finally { child.kill(); }
});
