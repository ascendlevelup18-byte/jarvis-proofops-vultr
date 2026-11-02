// Judge Mode shows the 17 Oct AMD run from committed evidence. These tests keep the displayed values
// identical to the evidence files, so the page cannot drift into invented numbers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { LATEST_EVIDENCE_FILES, LATEST_RUN } from "../src/lib/latest-amd-run.ts";

const root = new URL("../../../", import.meta.url);
const load = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

describe("17 Oct AMD run matches committed evidence", () => {
  const gate = load(LATEST_EVIDENCE_FILES.gate);
  const demo = load(LATEST_EVIDENCE_FILES.demo);

  test("gate: endpoint, model, startup, exit and leak scan", () => {
    assert.equal(new URL(gate.baseUrl).host, LATEST_RUN.endpointHost);
    assert.equal(gate.model, LATEST_RUN.model);
    assert.equal(gate.runId, LATEST_RUN.runId);
    assert.equal(gate.structuredOutput, LATEST_RUN.structuredOutput);
    assert.equal(gate.gitHead, LATEST_RUN.gitHead);
    assert.equal(gate.gitDirty, LATEST_RUN.gitDirty);
    assert.deepEqual(gate.startup.probes, LATEST_RUN.startup.probes);
    assert.equal(gate.startup.modelListed, LATEST_RUN.startup.modelListed);
    assert.equal(gate.startup.startupMs, LATEST_RUN.startup.startupMs);
    assert.equal(gate.exitCode, 0);
    assert.equal(gate.keyLeakFiles, LATEST_RUN.keyLeakFiles);
  });

  test("demo: every check passed, served model, and each case call by call", () => {
    assert.equal(demo.capturedAt, LATEST_RUN.capturedAt);
    assert.equal(demo.checks.length, LATEST_RUN.checksTotal);
    assert.equal(demo.checks.filter((c: { ok: boolean }) => c.ok).length, LATEST_RUN.checksPassed);
    assert.equal(demo.health.provider.lastCall.servedModel, LATEST_RUN.servedModel);
    assert.equal(demo.cases.length, LATEST_RUN.cases.length);
    for (const shown of LATEST_RUN.cases) {
      const c = demo.cases.find((x: { orderId: string }) => x.orderId === shown.orderId);
      assert.ok(c, shown.orderId);
      assert.equal(c.state, shown.state);
      assert.equal(c.policy, shown.policy);
      assert.equal(c.execution, shown.execution);
      assert.equal(c.verified, shown.verified);
      assert.deepEqual(c.aiCalls.map((a: { latencyMs: number }) => a.latencyMs), [...shown.latencies]);
      assert.ok(c.aiCalls.every((a: { adapter: string; error: unknown }) => a.adapter === `vllm:${LATEST_RUN.model}` && a.error === null));
    }
  });
});
