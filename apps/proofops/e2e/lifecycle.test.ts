// Round-2 lifecycle and evidence regressions, [CHROMIUM] tier (real local browser, scripted stub planner).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createStorefront, type Storefront } from "../src/storefront.ts";
import { newSignerKeys } from "../src/approval.ts";
import { stubPlanner } from "../src/model.ts";
import { runScenario, type RunConfig } from "../src/runner.ts";
import { verifyEvidence } from "../src/evidence.ts";

let store: Storefront;
let sf: RunConfig["storefront"];
let evidenceRoot: string;
before(async () => {
  store = createStorefront({ approvalPublicKey: newSignerKeys().publicKey });
  await new Promise<void>((r) => store.publicServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => store.trustedServer.listen(0, "127.0.0.1", r));
  sf = { trustedBase: `http://127.0.0.1:${(store.trustedServer.address() as AddressInfo).port}`, publicPort: (store.publicServer.address() as AddressInfo).port };
  evidenceRoot = mkdtempSync(join(tmpdir(), "proofops-life-"));
});
after(async () => {
  await store.close();
  rmSync(evidenceRoot, { recursive: true, force: true });
});
const base = (extra: Partial<RunConfig> = {}): RunConfig => ({ mode: "normal", planner: stubPlanner(), tier: "LOCAL_MODEL_STUB", storefront: sf, worker: { kind: "local" }, evidenceRoot, codeSha: "test", deployment: "local-test", ...extra });

test("R2-E [CHROMIUM] a worker that crashes mid-run ends as failed, never PASS, with teardown recorded", async () => {
  let killed = false;
  const planner = stubPlanner((step) => {
    if (step === 2 && !killed) {
      killed = true;
      const pid = (globalThis as { __proofopsWorkerPid?: number }).__proofopsWorkerPid;
      if (pid) process.kill(pid, "SIGKILL");
    }
    return undefined;
  });
  const r = await runScenario(base({ planner, onWorker: (w) => { (globalThis as { __proofopsWorkerPid?: number }).__proofopsWorkerPid = w.pid; } }));
  assert.ok(killed, "the harness killed the worker");
  assert.equal(r.status, "failed");
  assert.notEqual(r.verdict, "PASS");
  assert.equal(r.report.outcomes.cleanup, "PASS", "the dead worker is confirmed gone");
  assert.ok(verifyEvidence(r.evidenceDir, r.manifestSha256).ok, "partial evidence is still sealed and intact");
});

test("R2-F [CHROMIUM] a reused run id is refused instead of overwriting earlier evidence", async () => {
  const first = await runScenario(base({ runId: "run_20991231000000_deadbeef" }));
  const sealed = first.manifestSha256;
  await assert.rejects(runScenario(base({ runId: "run_20991231000000_deadbeef", mode: "wrong-total" })), /already exists/);
  assert.ok(verifyEvidence(first.evidenceDir, sealed).ok, "the first run's evidence is untouched");
});

test("R2-E [CHROMIUM] every run starts with no cookies or storage from an earlier run", async () => {
  const a = await runScenario(base());
  const b = await runScenario(base());
  const ev = (dir: string) => JSON.parse(readFileSync(join(dir, "worker-events.json"), "utf8")) as { type: string; profile?: string }[];
  const pa = ev(a.evidenceDir).find((e) => e.type === "worker.ready")?.profile;
  const pb = ev(b.evidenceDir).find((e) => e.type === "worker.ready")?.profile;
  assert.equal(pa, "ephemeral");
  assert.equal(pb, "ephemeral");
  const started = (dir: string) => JSON.parse(readFileSync(join(dir, "worker-events.json"), "utf8")).find((e: { type: string }) => e.type === "worker.cookies_at_start");
  assert.equal(started(b.evidenceDir)?.count, 0, "no cookies carried into the second run");
  assert.ok(!existsSync(join(b.evidenceDir, "..", a.runId, "screenshots", "nope.png")));
});
