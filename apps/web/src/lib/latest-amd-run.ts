// The 17 Oct 2026 owner-run AMD-hosted gate on the four canonical orders, copied from committed evidence for
// Judge Mode. Recorded data only: nothing here calls a model, and apps/web/test/latest-amd-run.test.ts keeps
// every value identical to evals/results/*20261017T210008Z.json. Separate from the 14 Oct run.

export const LATEST_EVIDENCE_FILES = {
  gate: "evals/results/live-gate-20261017T210008Z.json",
  demo: "evals/results/demo-evidence-live-20261017T210008Z.json",
} as const;

export const LATEST_RUN = {
  label: "Recorded AMD-hosted inference — October 17, 2026 — not a live model call on this page",
  runId: "tf-2",
  model: "DeepSeek-V4-Flash",
  servedModel: "self-dploy/DeepSeek-V4-Flash",
  endpointHost: "developer.amd.com.cn",
  structuredOutput: "json_object",
  gitHead: "da409c0e62491d23337168aadba6160295b03861",
  gitDirty: true,
  capturedAt: "2026-10-17T21:02:48.036Z",
  startup: { probes: { understanding: "ok", decision: "ok" }, modelListed: true, startupMs: 11777 },
  checksPassed: 25,
  checksTotal: 25,
  keyLeakFiles: 0,
  cases: [
    { orderId: "48291", label: "duplicate charge", state: "RESOLVED", policy: "APPROVE", execution: "ACCEPTED", verified: true, latencies: [1827, 8276] },
    { orderId: "48294", label: "$5,000 demand", state: "ESCALATED", policy: "DENY", execution: "none", verified: null, latencies: [3115, 6772] },
    { orderId: "48293", label: "already refunded", state: "CLOSED_NO_ACTION", policy: "NO_ACTION", execution: "none", verified: null, latencies: [1800, 6320] },
    { orderId: "48292", label: "$250 claimed vs $180 recorded", state: "ESCALATED", policy: "DENY", execution: "none", verified: null, latencies: [2899, 7946] },
  ],
} as const;
