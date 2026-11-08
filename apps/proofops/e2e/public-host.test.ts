// HTTP tier: Host and Origin rules for the deployment behind Caddy. Scripted planner, no browser run started.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const HOST = "judge.example.test";
let work: string;
let server: ChildProcess;
let base: string;

before(async () => {
  work = mkdtempSync(join(tmpdir(), "proofops-host-"));
  const port = 48100 + Math.floor(Math.random() * 800);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["apps/proofops/src/server.ts", "--port", String(port), "--evidence", join(work, "ev"), "--data", join(work, "db")],
    { cwd: ROOT, env: { ...process.env, PROOFOPS_TRUST_PROXY: "1", PROOFOPS_PUBLIC_HOST: HOST }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error("no start")), 20_000);
    server.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("control plane on")) { clearTimeout(t); ok(); } });
  });
});
after(async () => { server?.kill(); await new Promise((r) => setTimeout(r, 300)); rmSync(work, { recursive: true, force: true }); });

// node's fetch won't set Host, so these use raw requests.
import { request } from "node:http";
function call(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((ok, fail) => {
    const u = new URL(base + path);
    const r = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => ok({ status: res.statusCode!, text: t })); });
    r.on("error", fail);
    if (body) r.write(body);
    r.end();
  });
}
const proxied = (host: string, extra: Record<string, string> = {}) => ({ host, "x-forwarded-for": "203.0.113.9", ...extra });
const post = { "content-type": "application/json", "x-proofops": "1" };

test("PH-1 behind the proxy, any other Host is refused, which stops DNS rebinding", async () => {
  for (const host of ["evil.example", "127.0.0.1:4317", `${HOST}.evil.example`, ""]) {
    const r = await call("GET", "/api/trust", proxied(host));
    assert.equal(r.status, 421, host);
  }
  assert.equal((await call("GET", "/api/health", proxied(HOST))).status, 200);
  assert.equal((await call("GET", "/api/health", proxied(`${HOST}:443`))).status, 200);
});

test("PH-2 a state-changing request needs the public origin", async () => {
  const body = JSON.stringify({ text: "hello" });
  for (const origin of [undefined, "https://evil.example", `http://${HOST}`, `https://${HOST}.evil.example`, "null"]) {
    const r = await call("POST", "/api/tasks", proxied(HOST, { ...post, ...(origin ? { origin } : {}) }), body);
    assert.equal(r.status, 403, String(origin));
    assert.match(r.text, /wrong_origin/);
  }
  const ok = await call("POST", "/api/tasks", proxied(HOST, { ...post, origin: `https://${HOST}` }), body);
  assert.equal(ok.status, 422); // reached the interpreter, which asks for a real task
});

test("PH-3 a direct local request is the operator's and isn't affected", async () => {
  assert.equal((await call("GET", "/api/health", { host: "127.0.0.1" })).status, 200);
});

test("PH-4 a malformed request reveals no internal detail", async () => {
  const r = await call("POST", "/api/tasks", proxied(HOST, { ...post, origin: `https://${HOST}` }), "{not json");
  assert.equal(r.status, 400);
  assert.deepEqual(JSON.parse(r.text), { error: "bad_request" });
});
