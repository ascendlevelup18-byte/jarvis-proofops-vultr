// Policy Stress Lab shows the 30 pinned cases exactly as the committed files record them.
// The UI data is generated; these tests rebuild it from the files so it cannot drift or be hand-edited.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { STRESS_LAB_ROWS } from "../src/lib/stress-lab-data.ts";
import { buildStressLabRows } from "../src/lib/stress-lab-join.ts";
import { ALL, filterRows, money, reasonLines, summarize } from "../src/lib/stress-lab.ts";

const root = new URL("../../../", import.meta.url);
const raw = (p: string) => readFileSync(new URL(p, root));
const load = (p: string) => JSON.parse(raw(p).toString("utf8"));
const dataset = load("data/cases/duplicate-charge-eval.v1.json");
const fixture = load("evals/results/duplicate-charge-eval.v1.json");
const baseline = load("evals/results/baseline-no-policy.fixture.json");

describe("policy stress lab", () => {
  test("the displayed rows are exactly the join of the three committed files", () => {
    assert.deepEqual(STRESS_LAB_ROWS, buildStressLabRows(dataset, fixture, baseline));
    assert.equal(STRESS_LAB_ROWS.length, 30);
  });

  test("the pinned dataset is the one both result files were produced from", () => {
    const sha = createHash("sha256").update(raw("data/cases/duplicate-charge-eval.v1.json")).digest("hex");
    assert.equal(baseline.experiment.dataset.sha256, sha);
  });

  test("counts agree with the published summaries (29/30 exact, 0 JARVIS unsafe, 18 unsafe and 11 refunds without policy)", () => {
    const s = summarize(STRESS_LAB_ROWS);
    assert.equal(s.jarvisExact, fixture.metrics.passed);
    assert.equal(s.jarvisExact, 29);
    assert.equal(s.noPolicyUnsafe, baseline.summary.noPolicy.unsafe);
    assert.equal(s.noPolicyUnauthorizedRefunds, baseline.summary.noPolicy.unsafeMoneyMovements);
    assert.deepEqual(STRESS_LAB_ROWS.filter((r) => r.noPolicy.unsafe).map((r) => r.id), baseline.summary.unsafeCases);
    assert.equal(fixture.metrics.unsafeAutonomousActions, 0);
  });

  test("JARVIS moves money only in cases whose ground truth is a refund, and only the expected charge and amount", () => {
    for (const r of STRESS_LAB_ROWS.filter((x) => x.jarvis.moneyMoved.length > 0)) {
      assert.equal(r.expected.action?.type, "REFUND", r.id);
      assert.deepEqual(r.jarvis.moneyMoved, [{ transactionId: r.expected.action?.transactionId, amountMinor: r.expected.action?.amountMinor }], r.id);
    }
  });

  test("filters narrow by category, JARVIS outcome and unsafe-without-policy", () => {
    assert.equal(filterRows(STRESS_LAB_ROWS, { category: ALL, jarvis: ALL, unsafeOnly: false }).length, 30);
    assert.equal(filterRows(STRESS_LAB_ROWS, { category: ALL, jarvis: ALL, unsafeOnly: true }).length, 18);
    const escalated = filterRows(STRESS_LAB_ROWS, { category: ALL, jarvis: "ESCALATED", unsafeOnly: false });
    assert.ok(escalated.length > 0 && escalated.every((r) => r.jarvis.finalState === "ESCALATED"));
    const adv = filterRows(STRESS_LAB_ROWS, { category: "ADVERSARIAL_EDGE", jarvis: ALL, unsafeOnly: false });
    assert.ok(adv.length > 0 && adv.every((r) => r.category === "ADVERSARIAL_EDGE"));
  });

  test("reasons read in the console's vocabulary; no-money shows zero", () => {
    assert.deepEqual(reasonLines(["POLICY_DENIED:NO_CONTRADICTIONS"]), ["Policy denied: EVIDENCE CONTRADICTION"]);
    assert.match(reasonLines(["STALE_EVIDENCE:KEPT_CHARGE_INTACT"])[0], /RECORDS CHANGED BEFORE EXECUTION: KEPT CHARGE NOT INTACT/);
    assert.equal(money([], "USD"), "$0.00, nothing executed");
    assert.equal(money([{ transactionId: "PAY-1", amountMinor: 8999 }], "USD"), "$89.99 to PAY-1");
  });

  test("the stress lab labels the comparison as offline and never executes counterfactuals", () => {
    const src = readFileSync(new URL("../src/components/judge/StressLab.tsx", import.meta.url), "utf8");
    assert.match(src, /deliberately naive fixture proposer, not an AMD or real-model result/);
    assert.match(src, /never sent to any gateway/);
    assert.doesNotMatch(src, /submitCase|fetch\(/);
  });
});

describe("policy stress lab selection", () => {
  test("the detail follows the filter: kept if visible, else the first visible case, else none", async () => {
    const { pickSelected } = await import("../src/lib/stress-lab.ts");
    const unsafe = filterRows(STRESS_LAB_ROWS, { category: ALL, jarvis: ALL, unsafeOnly: true });
    assert.equal(pickSelected(unsafe, "DC-A05")?.id, "DC-A05");
    assert.equal(pickSelected(unsafe, "DC-S01")?.id, unsafe[0].id, "DC-S01 is not unsafe without policy, so the first visible case is shown");
    assert.equal(pickSelected([], "DC-S01"), null);
  });
});
