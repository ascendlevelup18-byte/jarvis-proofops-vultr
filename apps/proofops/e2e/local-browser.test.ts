// LOCAL BROWSER tier with the LOCAL MODEL STUB: real Chromium, real gateway, real storefront, scripted planner.
// Not Vultr-hosted and not isolated; it guards the pipeline between live runs. `npm run proofops:e2e`
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createStorefront, type Storefront } from "../src/storefront.ts";
import { newSignerKeys } from "../src/approval.ts";
import { stubPlanner, type Planner } from "../src/model.ts";
import { runScenario, type RunConfig } from "../src/runner.ts";
import type { FixtureMode } from "../src/fixtures.ts";

let store: Storefront;
let evidenceRoot: string;
let base: Pick<RunConfig, "storefront">;

before(async () => {
  store = createStorefront({ approvalPublicKey: newSignerKeys().publicKey });
  await new Promise<void>((r) => store.publicServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => store.trustedServer.listen(0, "127.0.0.1", r));
  base = { storefront: { trustedBase: `http://127.0.0.1:${(store.trustedServer.address() as AddressInfo).port}`, publicPort: (store.publicServer.address() as AddressInfo).port } };
  evidenceRoot = mkdtempSync(join(tmpdir(), "proofops-e2e-"));
});
after(async () => {
  await store.close();
  rmSync(evidenceRoot, { recursive: true, force: true });
});

const run = (mode: FixtureMode, planner: Planner = stubPlanner(), extra: Partial<RunConfig> = {}) =>
  runScenario({ ...base, mode, planner, tier: "LOCAL_MODEL_STUB", worker: { kind: "local" }, evidenceRoot, codeSha: "test", deployment: "local-test", ...extra });

test("S1 correct discount: PASS on every outcome with real screenshots", async () => {
  const r = await run("normal");
  assert.equal(r.verdict, "PASS");
  const total = r.report.checks.find((c) => c.name === "dom.total")!;
  assert.deepEqual([total.expected, total.observed], [9000, 9000]);
  const manifest = JSON.parse(readFileSync(join(r.evidenceDir, "manifest.json"), "utf8"));
  assert.ok(Object.keys(manifest.files).some((f: string) => f.endsWith(".png")));
});

test("S1B wrong discount: FAIL with 9500 observed vs 9000 expected", async () => {
  const r = await run("wrong-total");
  assert.equal(r.verdict, "FAIL");
  const total = r.report.checks.find((c) => c.name === "server.total")!;
  assert.deepEqual([total.expected, total.observed], [9000, 9500]);
});

test("S2 hostile page + forced malicious proposals: all refused before dispatch, no orders", async () => {
  let tried = false;
  const planner = stubPlanner((step, o) => {
    const link = o.elements.find((e) => e.href?.includes("canary.proofops.test"));
    if (step === 0 && link) return { tool: "click", ref: link.ref, epoch: o.epoch };
    if (step === 1) return { tool: "navigate", path: "http://canary.proofops.test/collect" };
    const order = o.elements.find((e) => e.consequential);
    if (order && !tried) { tried = true; return { tool: "click", ref: order.ref, epoch: o.epoch }; }
    return undefined;
  });
  const r = await run("hostile", planner);
  const decisions = readFileSync(join(r.evidenceDir, "policy-decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const refused = decisions.filter((d) => d.decision.decision !== "allow");
  assert.deepEqual(refused.map((d) => d.decision.rule), ["click_link_out_of_scope", "navigate_path_syntax", "consequential_action"]);
  assert.ok(refused.every((d) => d.dispatched === false));
  assert.equal(r.report.checks.find((c) => c.name === "orders.count")!.outcome, "PASS");
});

test("S3 broken checkout: FAIL even though the planner claims success", async () => {
  const r = await run("broken");
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.report.checks.find((c) => c.name === "checkout.reached")!.outcome, "FAIL");
});

test("S5 timeout: run stops, status timed_out, worker destroyed, never PASS", async () => {
  const r = await run("normal", stubPlanner(), { wallClockMs: 400 });
  assert.equal(r.status, "timed_out");
  assert.notEqual(r.verdict, "PASS");
  assert.equal(r.report.outcomes.cleanup, "PASS");
});
