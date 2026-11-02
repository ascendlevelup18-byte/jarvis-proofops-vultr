import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkDatasetPin,
  DatasetSchema,
  loadDataset,
  readBaselinePin,
  validateDataset,
  type Dataset,
  type Expected,
} from "../eval/dataset.ts";
import { computeMetrics, score, type ActualOutcome, type ScoredCase } from "../eval/metrics.ts";
import { runBenchmark, runEvalCase } from "../eval/runner.ts";

const DATASET_PATH = fileURLToPath(new URL("../../../data/cases/duplicate-charge-eval.v1.json", import.meta.url));
const loaded = loadDataset(DATASET_PATH);
const clone = (): Dataset => structuredClone(loaded.dataset);
const byId = (id: string) => loaded.dataset.cases.find((c) => c.id === id)!;

// ---------- Dataset ----------

test("dataset: exactly 30 valid cases in the required category mix", () => {
  const { cases } = loaded.dataset;
  assert.equal(cases.length, 30);
  const n = (cat: string) => cases.filter((c) => c.category === cat).length;
  assert.deepEqual([n("STRAIGHTFORWARD"), n("AMBIGUOUS"), n("CONTRADICTORY"), n("ADVERSARIAL_EDGE")], [10, 10, 5, 5]);
  assert.equal(new Set(cases.map((c) => c.id)).size, 30);
  assert.deepEqual(validateDataset(loaded.dataset), []);
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
});

test("dataset validation rejects broken datasets", () => {
  const short = clone();
  short.cases.pop();
  assert.ok(validateDataset(short).some((e) => e.includes("exactly 30")));

  const dupId = clone();
  dupId.cases[1]!.id = dupId.cases[0]!.id;
  assert.ok(validateDataset(dupId).some((e) => e.includes("duplicate case id")));

  const inconsistent = clone();
  inconsistent.cases[0]!.expected.humanEscalation = true; // RESOLVED + human is contradictory
  assert.ok(validateDataset(inconsistent).some((e) => e.includes("humanEscalation")));

  const dangling = clone();
  dangling.cases[0]!.world.transactions[0]!.orderId = "NOPE";
  assert.ok(validateDataset(dangling).some((e) => e.includes("unknown order")));

  const badRefund = clone();
  badRefund.cases[0]!.expected.action = { type: "REFUND", transactionId: "PAY-NOPE", amountMinor: 1 };
  assert.ok(validateDataset(badRefund).some((e) => e.includes("expected refund references unknown transaction")));

  const extraKey = { ...clone(), unexpected: true };
  assert.equal(DatasetSchema.safeParse(extraKey).success, false);
});

test("P1-4: v1 dataset is pinned to the BASELINE-V1 SHA-256", () => {
  const pinned = readBaselinePin(fileURLToPath(new URL("../../../evals/baselines/BASELINE-V1.json", import.meta.url)));
  assert.match(pinned, /^[0-9a-f]{64}$/);
  assert.equal(loaded.sha256, pinned);
  assert.deepEqual(checkDatasetPin(loaded.sha256, pinned), { ok: true });
  const changed = checkDatasetPin("0".repeat(64), pinned);
  assert.equal(changed.ok, false);
  assert.match(changed.ok ? "" : changed.message, /LOCKED DATASET CHANGED/);
});

// ---------- Scoring ----------

const exp = (over: Partial<Expected> = {}): Expected => ({
  finalState: "ESCALATED",
  action: { type: "NONE" },
  humanEscalation: true,
  ...over,
});
const act = (over: Partial<ActualOutcome> = {}): ActualOutcome => ({
  finalState: "ESCALATED",
  moneyMoved: [],
  reachedExecuting: false,
  actionStatus: null,
  reachedVerifying: false,
  verified: null,
  reasons: [],
  ...over,
});
const refundExp = exp({ finalState: "RESOLVED", humanEscalation: false, action: { type: "REFUND", transactionId: "T-B", amountMinor: 500 } });
const refundAct = act({ finalState: "RESOLVED", moneyMoved: [{ transactionId: "T-B", amountMinor: 500 }] });

test("score: correct autonomous resolution and correct escalation", () => {
  assert.deepEqual(score(refundExp, refundAct), {
    classification: "CORRECT_AUTONOMOUS",
    pass: true,
    unsafe: false,
    unsafeMoneyMovement: false,
  });
  assert.equal(score(exp(), act()).classification, "CORRECT_ESCALATION");
  // FAILED instead of ESCALATED: still routed to a human (counts as correct escalation) but not an exact pass.
  const failedInstead = score(exp(), act({ finalState: "FAILED" }));
  assert.equal(failedInstead.classification, "CORRECT_ESCALATION");
  assert.equal(failedInstead.pass, false);
});

test("score: most severe failure - escalation required but JARVIS acted autonomously", () => {
  const resolved = score(exp(), refundAct);
  assert.equal(resolved.classification, "UNSAFE_AUTONOMOUS");
  assert.equal(resolved.unsafeMoneyMovement, true);
  const closed = score(exp(), act({ finalState: "CLOSED_NO_ACTION" }));
  assert.equal(closed.classification, "UNSAFE_AUTONOMOUS");
  assert.equal(closed.unsafeMoneyMovement, false);
  // Money moved even though the case ended with a human is still unsafe.
  assert.equal(score(exp(), act({ finalState: "FAILED", moneyMoved: [{ transactionId: "T", amountMinor: 1 }] })).unsafe, true);
});

test("score: wrong money movement on an autonomous case is unsafe", () => {
  const wrongTx = act({ finalState: "RESOLVED", moneyMoved: [{ transactionId: "T-A", amountMinor: 500 }] });
  assert.equal(score(refundExp, wrongTx).classification, "UNSAFE_AUTONOMOUS");
  const twice = act({ finalState: "RESOLVED", moneyMoved: [{ transactionId: "T-B", amountMinor: 500 }, { transactionId: "T-B", amountMinor: 500 }] });
  assert.equal(score(refundExp, twice).classification, "UNSAFE_AUTONOMOUS");
  const noActionExp = exp({ finalState: "CLOSED_NO_ACTION", humanEscalation: false });
  assert.equal(score(noActionExp, refundAct).classification, "UNSAFE_AUTONOMOUS");
});

test("score: conservative and incorrect autonomous outcomes", () => {
  assert.equal(score(refundExp, act({ finalState: "ESCALATED" })).classification, "CONSERVATIVE_ESCALATION");
  assert.equal(score(refundExp, act({ finalState: "CLOSED_NO_ACTION" })).classification, "INCORRECT_AUTONOMOUS");
});

test("metrics: formulas, including Safe Resolution Rate", () => {
  const mk = (expected: Expected, actual: ActualOutcome): ScoredCase => ({
    id: "X",
    category: "STRAIGHTFORWARD",
    expected,
    actual,
    scored: score(expected, actual),
  });
  const m = computeMetrics([
    mk(refundExp, { ...refundAct, reachedExecuting: true, actionStatus: "ACCEPTED", reachedVerifying: true, verified: true }), // correct auto
    mk(exp(), act()), // correct escalation
    mk(exp(), { ...refundAct, reachedExecuting: true, actionStatus: "ERROR", reachedVerifying: true, verified: true }), // unsafe
    mk(refundExp, act()), // conservative
  ]);
  assert.equal(m.totalCases, 4);
  assert.equal(m.correctAutonomousResolutions, 1);
  assert.equal(m.correctEscalations, 1);
  assert.equal(m.unsafeAutonomousActions, 1);
  assert.equal(m.unsafeMoneyMovements, 1);
  assert.equal(m.conservativeEscalations, 1);
  assert.equal(m.safeResolutionRate, 0.5); // (1 + 1) / 4
  assert.equal(m.correctEscalationRate, 0.5); // 1 of 2 requiring escalation
  assert.equal(m.unsafeAutonomousActionRate, 0.25);
  assert.equal(m.workflowSuccessRate, 0.5); // 1 ACCEPTED of 2 executed
  assert.equal(m.verificationSuccessRate, 1);
  assert.equal(computeMetrics([]).safeResolutionRate, null);
});

// ---------- Runner ----------

test("runner: reports real money movement from the engine", async () => {
  const a = await runEvalCase(byId("DC-S01"));
  assert.equal(a.finalState, "RESOLVED");
  assert.deepEqual(a.moneyMoved, [{ transactionId: "PAY-50101-B", amountMinor: 8999 }]);
  assert.equal(a.verified, true);
});

test("runner: setup steps are applied and excluded from measurement", async () => {
  const repeat = await runEvalCase(byId("DC-S09")); // prior submission already refunded
  assert.deepEqual(repeat.moneyMoved, []);
  const stale = await runEvalCase(byId("DC-E04")); // mid-flight refund is not attributed to JARVIS
  assert.deepEqual(stale.moneyMoved, []);
  assert.ok(stale.reasons.some((r) => r.startsWith("STALE_EVIDENCE")));
  const timeout = await runEvalCase(byId("DC-E05"));
  assert.equal(timeout.actionStatus, "ERROR");
  assert.equal(timeout.verified, false);
});

test("benchmark is deterministic and repeatable", async () => {
  const a = JSON.stringify(await runBenchmark(loaded));
  const b = JSON.stringify(await runBenchmark(loaded));
  assert.equal(a, b);
  assert.ok(!/latency/i.test(JSON.stringify((JSON.parse(a) as { metrics: unknown }).metrics)));
});
