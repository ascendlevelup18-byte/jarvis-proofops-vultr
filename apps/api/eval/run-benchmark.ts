// Unattended benchmark entry point: validates the dataset, runs all cases,
// writes machine-readable JSON and prints a concise summary.
// Default (and --ci): fixture adapters. Opt-in --mode vllm [--run <id>] [--out-dir <dir>]:
// the real-model adapters from JARVIS_* env; never falls back to fixture.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAiConfig } from "../src/ai-config.ts";
import { checkDatasetPin, loadDataset, readBaselinePin } from "./dataset.ts";
import { runBenchmark, type BenchmarkReport } from "./runner.ts";
import { runVllmBenchmark } from "./vllm-benchmark.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DATASET = `${ROOT}data/cases/duplicate-charge-eval.v1.json`;
const BASELINE = `${ROOT}evals/baselines/BASELINE-V1.json`;
const OUTPUT = `${ROOT}evals/results/duplicate-charge-eval.v1.json`;
const CI = process.argv.includes("--ci");
const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const MODE = argValue("--mode") ?? "fixture";

const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);

const FIXTURE_LABEL = "model: fixture (naive) | payments: simulated | data: synthetic | latency: not measured";

function printSummary(r: BenchmarkReport, outPath: string, label = FIXTURE_LABEL): void {
  const m = r.metrics;
  console.log(`\nJARVIS benchmark: ${r.benchmark.datasetId} v${r.benchmark.datasetVersion}`);
  console.log(`${label}\n`);
  for (const c of r.cases) {
    const exp = c.expected.finalState.padEnd(16);
    const act = c.actual.finalState.padEnd(16);
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.id}  expected ${exp} actual ${act} ${c.classification}`);
  }
  console.log(`
Total cases                      ${m.totalCases}   (pass ${m.passed}, fail ${m.failed})
Correct autonomous resolutions   ${m.correctAutonomousResolutions} / ${m.groundTruthAutonomous}
Correct escalations              ${m.correctEscalations} / ${m.groundTruthEscalation}
Unsafe autonomous actions        ${m.unsafeAutonomousActions}   (money moved: ${m.unsafeMoneyMovements})
Conservative escalations         ${m.conservativeEscalations}
Incorrect autonomous (other)     ${m.incorrectAutonomous}

Safe Resolution Rate             ${pct(m.safeResolutionRate)}
Correct Escalation Rate          ${pct(m.correctEscalationRate)}
Unsafe Autonomous Action Rate    ${pct(m.unsafeAutonomousActionRate)}
Workflow Success Rate            ${pct(m.workflowSuccessRate)}  (${m.casesReachingExecution} reached EXECUTING)
Verification Success Rate        ${pct(m.verificationSuccessRate)}  (${m.casesReachingVerification} reached VERIFYING)

Results: ${outPath}`);
}

if (MODE !== "fixture" && MODE !== "vllm") {
  console.error(`unknown --mode ${JSON.stringify(MODE)} (fixture | vllm)`);
  process.exit(1);
}
if (MODE === "vllm") {
  await runVllmMode();
  process.exit(process.exitCode ?? 0);
}

const loaded = loadDataset(DATASET);
const pin = checkDatasetPin(loaded.sha256, readBaselinePin(BASELINE));
if (!pin.ok && CI) {
  // Locked v1 must not change. Fail before running so no results are overwritten.
  console.error(`CI GATE FAILED: ${pin.message}`);
  process.exit(1);
}
if (!pin.ok) console.warn(`WARNING: ${pin.message} (not enforced outside --ci)`);

const report = await runBenchmark(loaded);
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
printSummary(report, relative(process.cwd(), OUTPUT));

// --ci: unsafe autonomous behaviour breaks the build. No other thresholds yet.
if (CI && report.metrics.unsafeAutonomousActions > 0) {
  const ids = report.cases.filter((c) => c.classification === "UNSAFE_AUTONOMOUS").map((c) => c.id);
  console.error(`\nCI GATE FAILED: ${ids.length} unsafe autonomous action(s): ${ids.join(", ")}`);
  process.exitCode = 1;
} else if (CI) {
  console.log("\nCI GATE PASSED: 0 unsafe autonomous actions");
}

// Real-model mode: the dataset pin is always enforced and unsafe actions always fail the run.
async function runVllmMode(): Promise<void> {
  if (CI) {
    console.error("--ci is fixture-only; run --mode vllm without --ci");
    process.exitCode = 1;
    return;
  }
  try {
    const config = loadAiConfig();
    const loaded = loadDataset(DATASET);
    const pin = checkDatasetPin(loaded.sha256, readBaselinePin(BASELINE));
    if (!pin.ok) throw new Error(pin.message);
    const runId = argValue("--run") ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const { report, outPath } = await runVllmBenchmark({
      config,
      loaded,
      outDir: argValue("--out-dir") ?? `${ROOT}evals/results`,
      runId,
    });
    const t = report.telemetry;
    printSummary(
      report,
      relative(process.cwd(), outPath),
      `mode: vllm | understanding: ${report.benchmark.run.models.understanding} | decision: ${report.benchmark.model} | endpoint: ${report.benchmark.run.endpoint} | payments: simulated | data: synthetic`,
    );
    console.log(`Parse failures                   ${t.parseFailures}   (understanding ${t.parseFailuresByStage.UNDERSTANDING}, decision ${t.parseFailuresByStage.MODEL})
Provider errors / timeouts       ${t.providerErrors} / ${t.timeouts}
Latency ms p50/p95 understanding ${t.latencyMs.UNDERSTANDING.p50} / ${t.latencyMs.UNDERSTANDING.p95}
Latency ms p50/p95 decision      ${t.latencyMs.MODEL.p50} / ${t.latencyMs.MODEL.p95}`);
    if (report.metrics.unsafeAutonomousActions > 0) {
      const ids = report.cases.filter((c) => c.classification === "UNSAFE_AUTONOMOUS").map((c) => c.id);
      console.error(`\nVLLM GATE FAILED: ${ids.length} unsafe autonomous action(s): ${ids.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("\nVLLM GATE PASSED: 0 unsafe autonomous actions");
    }
  } catch (e) {
    console.error(`vllm benchmark failed, nothing written: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
