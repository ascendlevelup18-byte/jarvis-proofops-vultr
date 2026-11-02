// Merchant Impact Studio reproduces the business case's own examples and keeps every output a labelled hypothesis.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { DEFAULT_ASSUMPTIONS, computeImpact } from "../src/lib/merchant-impact.ts";

describe("merchant impact studio", () => {
  test("defaults reproduce BUSINESS_CASE.md §3: 400 × 30% × 8 min = 16 h ≈ $560", () => {
    const r = computeImpact(DEFAULT_ASSUMPTIONS);
    assert.equal(r.hoursSaved, 16);
    assert.equal(r.laborValue, 560);
  });

  test("the table rows in §3 (2,000 tickets at 30% and 50%)", () => {
    const at = (cases: number, pct: number) => computeImpact({ ...DEFAULT_ASSUMPTIONS, casesPerMonth: cases, autoResolvedPct: pct });
    assert.equal(at(2000, 30).hoursSaved, 80);
    assert.equal(at(2000, 30).laborValue, 2800);
    assert.equal(Math.round(at(2000, 50).hoursSaved), 133);
    assert.equal(Math.round(at(2000, 50).laborValue), 4667);
    assert.equal(Math.round(at(400, 50).laborValue), 933);
  });

  test("§4 pricing: 120 × $0.50 + 280 × $0.10 = $88, so the $99 minimum applies", () => {
    const r = computeImpact(DEFAULT_ASSUMPTIONS);
    assert.ok(Math.abs(r.usageFees - 88) < 1e-9);
    assert.equal(r.jarvisFee, 99);
    assert.equal(r.minimumApplies, true);
    assert.equal(r.modelCost, 0);
    assert.equal(r.netHypothesis, 560 - 99);
  });

  test("model cost scales with every case, and bad input is clamped rather than producing NaN", () => {
    assert.ok(Math.abs(computeImpact({ ...DEFAULT_ASSUMPTIONS, modelCostPerCase: 0.01 }).modelCost - 4) < 1e-9);
    const r = computeImpact({ ...DEFAULT_ASSUMPTIONS, casesPerMonth: Number.NaN, autoResolvedPct: 250, minutesPerCase: -3 });
    for (const v of Object.values(r)) if (typeof v === "number") assert.ok(Number.isFinite(v));
    assert.equal(r.hoursSaved, 0);
  });

  test("the studio says it is a hypothesis, not observed savings", () => {
    const src = readFileSync(new URL("../src/components/judge/MerchantImpact.tsx", import.meta.url), "utf8");
    assert.match(src, /not observed savings or ROI/);
    assert.match(src, /no customers or measured merchant data/);
    assert.match(src, /Not measured for JARVIS/);
  });
});

describe("merchant impact studio: unmeasured model cost", () => {
  test("the default $0 model cost is disclosed as unmeasured and excluded, next to the result", () => {
    assert.equal(DEFAULT_ASSUMPTIONS.modelCostPerCase, 0);
    const src = readFileSync(new URL("../src/components/judge/MerchantImpact.tsx", import.meta.url), "utf8");
    assert.match(src, /\(model cost not included\)/);
    assert.match(src, /JARVIS model cost per case has not been measured/);
  });
});

describe("merchant impact studio: input limits", async () => {
  const { LIMITS, clampNote } = await import("../src/lib/merchant-impact.ts");
  test("values inside the limits are used as entered; outside, the studio states the value it used", () => {
    assert.equal(clampNote("autoResolvedPct", 30), null);
    assert.equal(clampNote("autoResolvedPct", 250), "Above 100; using 100.");
    assert.equal(clampNote("minutesPerCase", -3), "Below 0; using 0.");
    assert.equal(clampNote("casesPerMonth", Number.NaN), "Not a number; using 0.");
  });
  test("the limits are the ones the calculation clamps to", () => {
    const at = (pct: number) => computeImpact({ ...DEFAULT_ASSUMPTIONS, autoResolvedPct: pct });
    assert.deepEqual(at(LIMITS.autoResolvedPct[1] + 50), at(LIMITS.autoResolvedPct[1]));
    const huge = computeImpact({ ...DEFAULT_ASSUMPTIONS, casesPerMonth: 1e12 });
    assert.deepEqual(huge, computeImpact({ ...DEFAULT_ASSUMPTIONS, casesPerMonth: LIMITS.casesPerMonth[1] }));
  });
});
