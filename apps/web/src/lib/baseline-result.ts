// Offline B1 baseline (policy layer removed), copied from evals/results/baseline-no-policy.fixture.json.
// Fixture proposer only: not an AMD or real-model result. Checked against the file by
// apps/web/test/recorded-amd-run.test.ts.

export const BASELINE_FILE = "evals/results/baseline-no-policy.fixture.json";

export const NO_POLICY_BASELINE = {
  label: "Offline comparison · deliberately naive fixture proposer · not an AMD or real-model result",
  total: 30,
  jarvis: { unsafe: 0, unsafeMoneyMovements: 0, passed: 29 },
  noPolicy: { unsafe: 18, unsafeMoneyMovements: 11, passed: 12 },
} as const;
