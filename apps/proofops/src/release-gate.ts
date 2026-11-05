// Non-destructive local release gate: `npm run proofops:release`.
// Runs every local tier, starts a throwaway control plane on a free port for the smoke missions, classifies all
// produced evidence, scans for secrets, statically checks deployment files, and reports infrastructure tiers as
// NOT_RUN (never as passed). Writes evidence-local/release-gate.json and exits non-zero on any FAIL.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyEvidence } from "./evidence.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
type Status = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
interface Gate { gate: string; tier: string; status: Status; detail: string; seconds: number }
const gates: Gate[] = [];
const node = process.execPath;

function record(gate: string, tier: string, fn: () => { ok: boolean; detail: string }) {
  const t0 = Date.now();
  let r: { ok: boolean; detail: string };
  try { r = fn(); } catch (e) { r = { ok: false, detail: (e as Error).message.slice(0, 300) }; }
  gates.push({ gate, tier, status: r.ok ? "PASS" : "FAIL", detail: r.detail, seconds: Math.round((Date.now() - t0) / 100) / 10 });
  console.log(`${r.ok ? "PASS   " : "FAIL   "} ${gate.padEnd(34)} ${r.detail}`);
}
function nodeTest(args: string[]) {
  const r = spawnSync(node, ["--test", ...args], { cwd: ROOT, encoding: "utf8", timeout: 1_200_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const n = (k: string) => Number(new RegExp(`ℹ ${k} (\\d+)`).exec(out)?.[1] ?? NaN);
  return { ok: r.status === 0 && n("fail") === 0, detail: `${n("pass")}/${n("tests")} passed, ${n("fail")} failed` };
}

console.log(`ProofOps release gate @ ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()}\n`);

record("typecheck", "UNIT", () => {
  const r = spawnSync(node, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "apps/proofops"], { cwd: ROOT, encoding: "utf8" });
  return { ok: r.status === 0, detail: r.status === 0 ? "clean" : (r.stdout || r.stderr).split("\n").slice(0, 3).join(" | ") };
});
record("unit + HTTP + model-fault tests", "UNIT/HTTP", () => nodeTest(["apps/proofops/test/*.test.ts", "apps/api/test/*.test.ts"]));
record("local Chromium + forced-attack e2e", "LOCAL_CHROMIUM/LOCAL_FORCED_ATTACK", () => nodeTest(["--test-concurrency=1", "apps/proofops/e2e/*.test.ts"]));

// Smoke missions against a throwaway control plane (own port, own evidence and database directories).
const work = mkdtempSync(join(tmpdir(), "proofops-gate-"));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
const server = spawn(node, ["apps/proofops/src/server.ts", "--port", String(port), "--evidence", join(work, "evidence"), "--data", join(work, "data")],
  { cwd: ROOT, env: { ...process.env }, stdio: "ignore" });
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  record("smoke: 6 missions as designed", "LOCAL_SCRIPTED", () => {
    const r = spawnSync(node, ["apps/proofops/src/smoke.ts", `http://127.0.0.1:${port}`], { cwd: ROOT, encoding: "utf8", timeout: 600_000 });
    const lines = (r.stdout ?? "").split("\n").filter((l) => /^(ok|FAIL)/.test(l));
    return { ok: r.status === 0, detail: `${lines.filter((l) => l.startsWith("ok")).length}/${lines.length} missions ok` };
  });
  record("evidence: every bundle intact and sealed", "LOCAL_SCRIPTED", () => {
    const dir = join(work, "evidence");
    const runs = existsSync(dir) ? readdirSync(dir) : [];
    const bad = runs.map((r) => ({ r, c: classifyEvidence(join(dir, r)) })).filter((x) => x.c.status === "TAMPERED" || x.c.status === "INCOMPLETE");
    return { ok: runs.length > 0 && bad.length === 0, detail: `${runs.length} bundles; ${bad.length} tampered/incomplete${bad.length ? ": " + bad.map((b) => `${b.r} ${b.c.reasons[0]}`).join("; ") : ""}` };
  });
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(work, { recursive: true, force: true });
}

record("secret scan (tracked files)", "REPO", () => {
  const r = spawnSync("git", ["grep", "-qIE", String.raw`sk-[A-Za-z0-9]{32,}|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_|sb_secret_|PROOFOPS_INFERENCE_API_KEY=[A-Za-z0-9]`, "--", ".", ":!**/package-lock.json", ":!package-lock.json", ":!apps/proofops/src/release-gate.ts"], { cwd: ROOT, encoding: "utf8" });
  if (r.status === 1) return { ok: true, detail: "no secret patterns" };
  if (r.status !== 0) return { ok: false, detail: "git grep could not scan tracked files" };
  return { ok: false, detail: "secret patterns matched tracked files" };
});

record("deployment files consistent with code", "STATIC", () => {
  const problems: string[] = [];
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const f of ["ops/vm-bootstrap.sh", "ops/deploy-app.sh"]) if (spawnSync(bash, ["-n", f], { cwd: ROOT }).status !== 0) problems.push(`${f} syntax`);
  const unit = readFileSync(join(ROOT, "ops/proofops.service"), "utf8");
  const server = readFileSync(join(ROOT, "apps/proofops/src/server.ts"), "utf8");
  for (const flag of ["--sandbox", "--port", "--deployment", "--evidence", "--data"]) {
    if (unit.includes(flag) && !server.includes(`arg("${flag.slice(2)}"`) && !server.includes(`"${flag}"`)) problems.push(`unit flag ${flag} unknown to server`);
  }
  if (!/RuntimeDirectory=proofops/.test(unit) || !server.includes(`socketRoot: "/run/proofops"`)) problems.push("socket directory mismatch");
  const pinned = (JSON.parse(readFileSync(join(ROOT, "apps/proofops/worker/package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies.playwright;
  const docker = readFileSync(join(ROOT, "apps/proofops/worker/Dockerfile"), "utf8");
  if (!docker.includes(`playwright:v${pinned}-`)) problems.push(`Dockerfile base does not match playwright ${pinned}`);
  if (!readFileSync(join(ROOT, "ops/deploy-app.sh"), "utf8").includes(`proofops-worker:${pinned}`)) problems.push("deploy image tag mismatch");
  if (!/flush_interval -1/.test(readFileSync(join(ROOT, "ops/Caddyfile"), "utf8"))) problems.push("Caddy would buffer live updates");
  if (!/--host-uds=open/.test(readFileSync(join(ROOT, "ops/vm-bootstrap.sh"), "utf8"))) problems.push("runsc not configured for the gateway socket");
  return { ok: problems.length === 0, detail: problems.length ? problems.join("; ") : "bootstrap, deploy, unit, Caddy, worker image and runtime flags agree" };
});

record("working tree clean (no evidence drift)", "REPO", () => {
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return { ok: dirty.length === 0, detail: dirty.length ? `${dirty.length} uncommitted: ${dirty.slice(0, 3).join(", ")}` : "clean" };
});

for (const [gate, tier, status, why] of [
  ["gVisor boundary probe (vm-boundary.ts)", "VULTR_GVISOR", "NOT_RUN", "runs on the VM only; last result in proof/"],
  ["sandboxed missions on the VM", "VULTR_GVISOR", "NOT_RUN", "runs on the VM only; last result in proof/"],
  ["public HTTPS rehearsal (rehearse.mjs)", "VULTR_GVISOR", "NOT_RUN", "run against the deployed URL; last result in proof/"],
  ["live Vultr model missions", "VULTR_LIVE_MODEL", "NOT_RUN", "runs on the VM and costs tokens; last result in proof/"],
] as const) {
  gates.push({ gate, tier, status: status as Status, detail: why, seconds: 0 });
  console.log(`${status.padEnd(7)} ${gate.padEnd(34)} ${why}`);
}

const failed = gates.filter((g) => g.status === "FAIL").length;
const summary = { at: new Date().toISOString(), head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), gates,
  passed: gates.filter((g) => g.status === "PASS").length, failed, blocked: gates.filter((g) => g.status === "BLOCKED").length };
mkdirSync(join(ROOT, "evidence-local"), { recursive: true });
writeFileSync(join(ROOT, "evidence-local", "release-gate.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} passed, ${failed} failed, ${summary.blocked} blocked, ${gates.filter((g) => g.status === "NOT_RUN").length} not run here (VM tier). Report: evidence-local/release-gate.json`);
process.exit(failed ? 1 : 0);
