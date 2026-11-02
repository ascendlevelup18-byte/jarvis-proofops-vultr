import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import {
  FIXTURE_BENCHMARK,
  FIXTURE_BENCHMARK_LABEL,
  FIXTURE_BENCHMARK_NOTE,
  FIXTURE_BENCHMARK_SCOPE,
} from "../src/lib/bench-metrics.ts";

const webRoot = join(import.meta.dirname, "..");
const srcRoot = join(webRoot, "src");
const repoRoot = join(webRoot, "..", "..");

/** Files allowed to import bench-metrics without rendering figures: the notice itself, and the System page (dataset SHA only). */
const NON_FIGURE_IMPORTERS = new Set(["components/ui/FixtureBenchmarkNotice.tsx", "pages/SystemPage.tsx"]);

/** Benchmark figures written out as literals (would bypass the import check). */
const LITERAL_FIGURE = /96\.7|29\s*\/\s*30|20\s*\/\s*20|9\s*\/\s*10|\b0 unsafe/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

const rel = (f: string) => relative(srcRoot, f).split(sep).join("/");
/** Drop line, block and JSX comments so a commented-out notice does not count. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Files that render benchmark figures: they import bench-metrics, or contain a figure literal. */
function figureRenderers(): string[] {
  return sourceFiles(srcRoot).filter((f) => {
    const name = rel(f);
    if (name === "lib/bench-metrics.ts" || NON_FIGURE_IMPORTERS.has(name)) return false;
    const src = stripComments(readFileSync(f, "utf8"));
    return /from\s+["'][^"']*bench-metrics(\.ts)?["']/.test(src) || LITERAL_FIGURE.test(src);
  });
}

describe("public fixture benchmark labelling", () => {
  it("names the figures as pre-kickoff fixture results, not AMD / real-model results", () => {
    assert.equal(FIXTURE_BENCHMARK_LABEL, "PRE-KICKOFF FIXTURE BENCHMARK");
    assert.equal(FIXTURE_BENCHMARK_SCOPE, "NOT AMD / NOT REAL-MODEL RESULTS");
    assert.equal(
      FIXTURE_BENCHMARK_NOTE,
      "Measured against JARVIS’s locked synthetic fixture benchmark. Real AMD-hosted model evaluation begins during ACT III.",
    );
  });

  it("shows the notice in every file that renders benchmark figures", () => {
    const renderers = figureRenderers();
    assert.deepEqual(renderers.map(rel).sort(), ["components/operations/CommandCenter.tsx", "pages/BenchmarksPage.tsx"]);
    for (const f of renderers) {
      assert.match(stripComments(readFileSync(f, "utf8")), /<FixtureBenchmarkNotice\b/, `${rel(f)} renders benchmark figures without <FixtureBenchmarkNotice>`);
    }
  });

  it("the System page uses bench-metrics only for the dataset SHA", () => {
    const src = stripComments(readFileSync(join(srcRoot, "pages/SystemPage.tsx"), "utf8"));
    const uses = [...src.matchAll(/FIXTURE_BENCHMARK\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(uses)], ["datasetSha256"]);
    assert.doesNotMatch(src, LITERAL_FIGURE);
  });

  it("the notice component renders label, scope and note", () => {
    const src = stripComments(readFileSync(join(srcRoot, "components/ui/FixtureBenchmarkNotice.tsx"), "utf8"));
    for (const name of ["FIXTURE_BENCHMARK_LABEL", "FIXTURE_BENCHMARK_SCOPE", "FIXTURE_BENCHMARK_NOTE"]) {
      assert.match(src, new RegExp(`\\{${name}\\}`), `notice does not render ${name}`);
    }
  });

  it("displayed figures and counts match the committed fixture benchmark results", () => {
    const results = JSON.parse(readFileSync(join(repoRoot, "evals/results/duplicate-charge-eval.v1.json"), "utf8"));
    const m = results.metrics;
    assert.equal(FIXTURE_BENCHMARK.datasetSha256, results.benchmark.datasetSha256);
    assert.equal(FIXTURE_BENCHMARK.unsafeAutonomousActions, m.unsafeAutonomousActions);
    assert.equal(FIXTURE_BENCHMARK.safeResolutionRate.toFixed(3), m.safeResolutionRate.toFixed(3));
    assert.equal(FIXTURE_BENCHMARK.correctEscalationRate, m.correctEscalationRate);
    assert.equal(FIXTURE_BENCHMARK.workflowSuccessRate, m.workflowSuccessRate);
    assert.equal(FIXTURE_BENCHMARK.verificationSuccessRate, m.verificationSuccessRate);
    for (const k of [
      "totalCases",
      "passed",
      "failed",
      "correctAutonomousResolutions",
      "correctEscalations",
      "conservativeEscalations",
      "groundTruthAutonomous",
      "groundTruthEscalation",
    ] as const) {
      assert.equal(FIXTURE_BENCHMARK[k], m[k], k);
    }
  });
});
