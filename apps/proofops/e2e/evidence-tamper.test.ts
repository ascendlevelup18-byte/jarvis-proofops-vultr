// [CHROMIUM] Evidence corruption matrix: each tampering of a real run bundle must classify as TAMPERED (or
// INCOMPLETE where a record is honestly missing), never as the original PASS/FAIL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createStorefront, type Storefront } from "../src/storefront.ts";
import { newSignerKeys } from "../src/approval.ts";
import { stubPlanner } from "../src/model.ts";
import { runScenario, type RunResult } from "../src/runner.ts";
import { classifyEvidence } from "../src/evidence.ts";

let store: Storefront;
let root: string;
let pass: RunResult;
let fail: RunResult;

before(async () => {
  store = createStorefront({ approvalPublicKey: newSignerKeys().publicKey });
  await new Promise<void>((r) => store.publicServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => store.trustedServer.listen(0, "127.0.0.1", r));
  root = mkdtempSync(join(tmpdir(), "proofops-tamper-"));
  const storefront = { trustedBase: `http://127.0.0.1:${(store.trustedServer.address() as AddressInfo).port}`, publicPort: (store.publicServer.address() as AddressInfo).port };
  const cfg = { planner: stubPlanner(), tier: "LOCAL_MODEL_STUB" as const, storefront, worker: { kind: "local" as const }, evidenceRoot: root, codeSha: "test", deployment: "local-test" };
  pass = await runScenario({ ...cfg, mode: "normal" });
  fail = await runScenario({ ...cfg, mode: "wrong-total", planner: stubPlanner() });
});
after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });

/** Copies a sealed bundle so each corruption starts from a clean original. */
function copyOf(r: RunResult, suffix: string) {
  const dir = join(root, `copy-${suffix}`, r.runId);
  cpSync(r.evidenceDir, dir, { recursive: true });
  return dir;
}

test("untouched bundles classify as their sealed verdicts", () => {
  assert.equal(classifyEvidence(pass.evidenceDir, pass.manifestSha256).status, "PASS");
  assert.equal(classifyEvidence(fail.evidenceDir, fail.manifestSha256).status, "FAIL");
});

test("changed screenshot bytes -> TAMPERED", () => {
  const d = copyOf(pass, "shot");
  const f = join(d, "screenshots", "verify-cart.png");
  const b = readFileSync(f); b[b.length - 10] = (b[b.length - 10] ?? 0) ^ 0xff; writeFileSync(f, b);
  assert.equal(classifyEvidence(d, pass.manifestSha256).status, "TAMPERED");
});

test("a failed run rewritten to PASS (assertions and manifest) -> TAMPERED, never PASS", () => {
  const d = copyOf(fail, "verdict");
  const a = JSON.parse(readFileSync(join(d, "assertions.json"), "utf8")); a.verdict = "PASS"; a.outcomes.commerce = "PASS";
  writeFileSync(join(d, "assertions.json"), JSON.stringify(a, null, 2));
  assert.equal(classifyEvidence(d, fail.manifestSha256).status, "TAMPERED");
  // Even if the manifest is regenerated to match, the anchored hash catches it.
  const m = JSON.parse(readFileSync(join(d, "manifest.json"), "utf8"));
  m.verdict = "PASS";
  m.files["assertions.json"] = (await_sha(join(d, "assertions.json")));
  writeFileSync(join(d, "manifest.json"), JSON.stringify(m, null, 2));
  assert.equal(classifyEvidence(d, fail.manifestSha256).status, "TAMPERED");
});

test("edited policy decision, deleted store receipt, removed teardown record -> TAMPERED", () => {
  const p = copyOf(pass, "policy");
  const pf = join(p, "policy-decisions.jsonl");
  writeFileSync(pf, readFileSync(pf, "utf8").replace('"decision":"allow"', '"decision":"deny"'));
  assert.equal(classifyEvidence(p, pass.manifestSha256).status, "TAMPERED");
  const s = copyOf(pass, "receipt");
  unlinkSync(join(s, "server-state.json"));
  assert.equal(classifyEvidence(s, pass.manifestSha256).status, "TAMPERED");
  const c = copyOf(pass, "teardown");
  unlinkSync(join(c, "cleanup.json"));
  assert.equal(classifyEvidence(c, pass.manifestSha256).status, "TAMPERED");
});

test("a screenshot reused from another run -> TAMPERED", () => {
  const d = copyOf(fail, "reuse");
  cpSync(join(pass.evidenceDir, "screenshots", "verify-cart.png"), join(d, "screenshots", "verify-cart.png"));
  assert.equal(classifyEvidence(d, fail.manifestSha256).status, "TAMPERED");
});

test("swapped run ids (bundle renamed to another run) -> TAMPERED", () => {
  const d = copyOf(fail, "swap");
  const swapped = join(root, "copy-swap", pass.runId);
  renameSync(d, swapped);
  const r = classifyEvidence(swapped, pass.manifestSha256);
  assert.equal(r.status, "TAMPERED");
});

test("an assertion edited after completion (frozen spec changed) -> TAMPERED", () => {
  const d = copyOf(fail, "spec");
  const sp = JSON.parse(readFileSync(join(d, "spec.json"), "utf8"));
  sp.expected.totalCents = 9500; // make the wrong total look expected
  writeFileSync(join(d, "spec.json"), JSON.stringify(sp, null, 2));
  assert.equal(classifyEvidence(d, fail.manifestSha256).status, "TAMPERED");
});

test("without the anchor, a fully regenerated manifest is NOT detectable, and the result says so", () => {
  const r = classifyEvidence(pass.evidenceDir);
  assert.match(r.integrity, /cannot be detected/);
});

import { createHash } from "node:crypto";
function await_sha(f: string) { return createHash("sha256").update(readFileSync(f)).digest("hex"); }
