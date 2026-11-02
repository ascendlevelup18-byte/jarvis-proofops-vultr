/**
 * Fixture-benchmark metrics only — from the verified post-hardening bench run.
 * Shown publicly, but always under FIXTURE_BENCHMARK_LABEL + FIXTURE_BENCHMARK_SCOPE
 * (rendered by <FixtureBenchmarkNotice>). Never present as AMD / vLLM / production KPIs.
 *
 * Source of truth: evals/results/duplicate-charge-eval.v1.json (`npm run api:bench:ci`);
 * apps/web/test/benchmark-labels.test.ts fails if these figures drift from it.
 * Dataset SHA pinned by CI gate (BASELINE-V1).
 */

export const FIXTURE_BENCHMARK_LABEL = "PRE-KICKOFF FIXTURE BENCHMARK";
export const FIXTURE_BENCHMARK_SCOPE = "NOT AMD / NOT REAL-MODEL RESULTS";
export const FIXTURE_BENCHMARK_NOTE =
  "Measured against JARVIS’s locked synthetic fixture benchmark. Real AMD-hosted model evaluation begins during ACT III.";

export const FIXTURE_BENCHMARK = {
  label: FIXTURE_BENCHMARK_LABEL,
  disclaimer:
    "Development results. Fixture model, simulated payments, synthetic data. Not AMD inference. Not production.",
  datasetId: "jarvis-duplicate-charge-eval",
  datasetVersion: "1.0.0",
  datasetSha256: "d5a8b4064b81bf8bfd69f95e8e0b6aa081529d63b053287a2761d3f4c9c28e47",
  totalCases: 30,
  passed: 29,
  failed: 1,
  groundTruthAutonomous: 10,
  groundTruthEscalation: 20,
  correctAutonomousResolutions: 9,
  correctEscalations: 20,
  unsafeAutonomousActions: 0,
  conservativeEscalations: 1,
  safeResolutionRate: 0.967,
  correctEscalationRate: 1.0,
  unsafeAutonomousActionRate: 0.0,
  workflowSuccessRate: 0.8,
  verificationSuccessRate: 0.8,
  model: "FixtureModelAdapter",
  payments: "SimulatedPaymentGateway (no real money)",
  data: "synthetic",
} as const;

export function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
