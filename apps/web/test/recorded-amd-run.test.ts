// Judge Mode replays the 14 Oct AMD run from committed evidence. These tests keep the
// displayed copy identical to the evidence files, so the UI cannot drift into invented numbers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { EVIDENCE_FILES, RECORDED_RUN, replayTimeline } from "../src/lib/recorded-amd-run.ts";
import { BASELINE_FILE, NO_POLICY_BASELINE } from "../src/lib/baseline-result.ts";

const root = new URL("../../../", import.meta.url);
const load = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

describe("recorded AMD run matches committed evidence", () => {
  const smoke = load(EVIDENCE_FILES.smoke);
  const gate = load(EVIDENCE_FILES.gate);
  const demo = load(EVIDENCE_FILES.demo);
  const bench = load(EVIDENCE_FILES.bench);

  test("endpoint, model identity and smoke call", () => {
    assert.equal(new URL(smoke.base_url).host, RECORDED_RUN.endpointHost);
    assert.equal(smoke.model_requested, RECORDED_RUN.model);
    assert.equal(smoke.model_returned, RECORDED_RUN.servedModel);
    assert.equal(smoke.latency_ms, RECORDED_RUN.smoke.latencyMs);
    assert.equal(smoke.http_status, RECORDED_RUN.smoke.httpStatus);
    assert.equal(smoke.prompt_tokens, RECORDED_RUN.smoke.promptTokens);
    assert.equal(smoke.completion_tokens, RECORDED_RUN.smoke.completionTokens);
    assert.equal(Number(smoke.rate_limit_headers["x-ratelimit-limit-user-rpm"]), RECORDED_RUN.smoke.rpmLimit);
    assert.equal(Number(smoke.rate_limit_headers["x-ratelimit-limit-user-daily-usd"]), RECORDED_RUN.smoke.dailyUsdLimit);
  });

  test("startup gate", () => {
    assert.equal(gate.model, RECORDED_RUN.model);
    assert.equal(gate.structuredOutput, RECORDED_RUN.structuredOutput);
    assert.equal(gate.gitHead, RECORDED_RUN.gitHead);
    assert.equal(gate.gitDirty, RECORDED_RUN.gitDirty);
    assert.deepEqual(gate.startup.probes, RECORDED_RUN.startup.probes);
    assert.equal(gate.startup.modelListed, RECORDED_RUN.startup.modelListed);
    assert.equal(gate.startup.startupMs, RECORDED_RUN.startup.startupMs);
  });

  test("demo cases and checks, call by call", () => {
    assert.equal(demo.capturedAt, RECORDED_RUN.demo.capturedAt);
    assert.equal(demo.health.aiMode, "vllm");
    assert.equal(demo.health.paymentGateway, "simulated");
    assert.equal(demo.checks.length, RECORDED_RUN.demo.checksTotal);
    assert.equal(demo.checks.filter((c: { ok: boolean }) => c.ok).length, RECORDED_RUN.demo.checksPassed);
    assert.deepEqual(demo.cases, RECORDED_RUN.demo.cases);
    assert.deepEqual(demo.checks.map((c: { name: string; detail: string }) => [c.name, c.detail]), RECORDED_RUN.demo.checks);
  });

  test("benchmark summary, failures and latency", () => {
    const m = bench.metrics;
    const b = RECORDED_RUN.bench;
    assert.equal(bench.benchmark.run.runId, b.runId);
    assert.equal(bench.benchmark.run.startedAt, b.startedAt);
    assert.equal(bench.benchmark.run.finishedAt, b.finishedAt);
    assert.deepEqual(bench.benchmark.run.scriptedModelCases, b.scriptedModelCases);
    for (const k of ["totalCases", "passed", "unsafeAutonomousActions", "unsafeMoneyMovements", "correctEscalations", "groundTruthEscalation", "correctAutonomousResolutions", "groundTruthAutonomous", "conservativeEscalations", "safeResolutionRate"] as const) {
      assert.equal(m[k], b[k], k);
    }
    assert.deepEqual(bench.telemetry.failedCases, b.failedCases);
    assert.deepEqual(bench.telemetry.latencyMs, b.latencyMs);
  });

  test("the displayed misses are exactly the benchmark's non-passing cases, and none moved money", () => {
    const b = RECORDED_RUN.bench;
    const misses = bench.cases.filter((c: { pass: boolean }) => !c.pass);
    assert.deepEqual(
      b.missedCases,
      misses.map((c: { id: string; expected: { finalState: string }; actual: { finalState: string; reasons: string[] } }) => ({
        id: c.id,
        expected: c.expected.finalState,
        actual: c.actual.finalState,
        reasons: c.actual.reasons,
      })),
    );
    assert.equal(b.missedCases.length, b.totalCases - b.passed);
    for (const c of misses) assert.deepEqual(c.actual.moneyMoved, [], c.id);
  });

  test("replay timeline follows the recorded call order", () => {
    const t = replayTimeline();
    assert.equal(t.length, 6);
    assert.equal(t[0].offsetMs, 0);
    for (let i = 1; i < t.length; i++) assert.ok(t[i].offsetMs > t[i - 1].offsetMs);
    assert.ok(t.every((e) => e.adapter === "vllm:DeepSeek-V4-Flash"));
  });

  test("the no-policy baseline shown in Judge Mode matches its result file", () => {
    const r = load(BASELINE_FILE);
    assert.equal(r.experiment.mode, "fixture");
    assert.equal(r.cases.length, NO_POLICY_BASELINE.total);
    assert.deepEqual(r.summary.jarvis, { ...NO_POLICY_BASELINE.jarvis, total: NO_POLICY_BASELINE.total });
    assert.deepEqual(r.summary.noPolicy, { ...NO_POLICY_BASELINE.noPolicy, total: NO_POLICY_BASELINE.total });
    assert.match(NO_POLICY_BASELINE.label, /not an AMD or real-model result/);
  });

  test("the label never claims a live call", () => {
    assert.match(RECORDED_RUN.label, /Recorded/);
    assert.match(RECORDED_RUN.label, /not a live model call/);
  });
});
