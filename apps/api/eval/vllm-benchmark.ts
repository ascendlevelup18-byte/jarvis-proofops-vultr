// Opt-in real-model benchmark (run-benchmark --mode vllm). Same dataset, engine and
// scoring as the fixture benchmark, with the vLLM adapters in place of the fixtures.
// Fails closed: the endpoint must pass the same startup checks as the API. Results go
// to their own file per run and never overwrite the fixture results or baselines.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiConfig } from "../src/ai-config.ts";
import { initializeAi, type AiInitOptions } from "../src/ai-mode.ts";
import type { Case } from "../src/contracts.ts";
import type { LoadedDataset } from "./dataset.ts";
import { runBenchmark, SCRIPTED_MODEL_ADAPTER_ID } from "./runner.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface VllmBenchmarkOptions {
  config: AiConfig;
  loaded: LoadedDataset;
  outDir: string;
  runId: string;
  onCall?: AiInitOptions["onCall"];
}

interface LatencyStats {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

// Next to the fixture results (duplicate-charge-eval.v1.json), one file per model and run.
export function vllmResultsFileName(modelName: string, runId: string): string {
  const slug = modelName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `duplicate-charge-eval.v1.vllm-${slug}-${runId}.json`;
}

export async function runVllmBenchmark(opts: VllmBenchmarkOptions) {
  const { config, loaded } = opts;
  if (config.mode !== "vllm" || !config.modelName) {
    throw new Error("--mode vllm requires JARVIS_AI_MODE=vllm with JARVIS_MODEL_BASE_URL and JARVIS_MODEL_NAME");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(opts.runId) || opts.runId.includes("..")) {
    throw new Error(`invalid run id ${JSON.stringify(opts.runId)} (letters, digits, . _ - only)`);
  }
  // Two-model runs are named after both models (understanding first) so they never collide with one-model runs.
  const understandingModel = config.understandingModelName ?? config.modelName;
  const fileModel = understandingModel === config.modelName ? config.modelName : `${understandingModel}+${config.modelName}`;
  const outPath = join(opts.outDir, vllmResultsFileName(fileModel, opts.runId));
  if (existsSync(outPath)) throw new Error(`${outPath} already exists; choose a new --run id`);

  const startedAt = new Date().toISOString();
  const { runtime, startup } = await initializeAi(config, opts.onCall ? { onCall: opts.onCall } : {});

  const observed: { id: string; c: Case }[] = [];
  const base = await runBenchmark(loaded, {
    adapters: { understanding: runtime.understanding, model: runtime.model, modelTimeoutMs: runtime.engineTimeoutMs },
    observe: (id, c) => observed.push({ id, c }),
  });

  const scriptedModelCases = loaded.dataset.cases.filter((c) => c.model.kind === "raw").map((c) => c.id);
  const report = {
    ...base,
    benchmark: {
      ...base.benchmark,
      mode: "vllm" as const,
      model: runtime.model.id,
      notMeasured: ["business impact"],
      run: {
        runId: opts.runId,
        ...gitState(),
        startedAt,
        finishedAt: new Date().toISOString(),
        endpoint: startup.endpoint,
        models: { understanding: startup.understandingModel, decision: startup.model },
        structuredOutput: startup.structuredOutput,
        understandingStructuredOutput: startup.understandingStructuredOutput,
        engineTimeoutMs: runtime.engineTimeoutMs,
        promptVersions: startup.promptVersions,
        startupMs: startup.startupMs,
        scriptedModelCases,
        note: "Real-model mode: validity depends on the endpoint named above. Dataset cases with scripted model output are not model measurements.",
      },
    },
    telemetry: telemetry(observed, new Set(scriptedModelCases)),
  };

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return { report, outPath };
}

export type VllmBenchmarkReport = Awaited<ReturnType<typeof runVllmBenchmark>>["report"];

// Reason codes and audited call latencies of the measured run of each case. Decision-stage
// outcomes of cases whose model output is scripted by the dataset are not model results.
function telemetry(observed: { id: string; c: Case }[], scripted: Set<string>) {
  const parseFailuresByStage = { UNDERSTANDING: 0, MODEL: 0 };
  const latencies: Record<"UNDERSTANDING" | "MODEL", number[]> = { UNDERSTANDING: [], MODEL: [] };
  let providerErrors = 0;
  let timeouts = 0;
  const failedCases: { id: string; reasons: string[] }[] = [];
  for (const { id, c } of observed) {
    const codes = c.reasons.map((r) => r.code);
    for (const code of codes) {
      if (scripted.has(id) && code.startsWith("MODEL_")) continue;
      if (code === "UNDERSTANDING_OUTPUT_INVALID") parseFailuresByStage.UNDERSTANDING++;
      if (code === "MODEL_OUTPUT_INVALID") parseFailuresByStage.MODEL++;
      if (code === "UNDERSTANDING_ERROR" || code === "MODEL_ERROR") providerErrors++;
      if (code === "UNDERSTANDING_TIMEOUT" || code === "MODEL_TIMEOUT") timeouts++;
    }
    if (c.state === "FAILED") failedCases.push({ id, reasons: codes });
    for (const e of c.audit) {
      const data = e.data as { adapter?: string; latencyMs?: number } | null;
      if (typeof data?.latencyMs !== "number" || data.adapter === SCRIPTED_MODEL_ADAPTER_ID) continue;
      if (e.type === "UNDERSTANDING_CALL") latencies.UNDERSTANDING.push(data.latencyMs);
      if (e.type === "MODEL_CALL") latencies.MODEL.push(data.latencyMs);
    }
  }
  return {
    parseFailures: parseFailuresByStage.UNDERSTANDING + parseFailuresByStage.MODEL,
    parseFailuresByStage,
    providerErrors,
    timeouts,
    failedCases,
    latencyMs: { UNDERSTANDING: stats(latencies.UNDERSTANDING), MODEL: stats(latencies.MODEL) },
  };
}

function stats(xs: number[]): LatencyStats {
  if (xs.length === 0) return { count: 0, p50: null, p95: null, max: null };
  const s = xs.toSorted((a, b) => a - b);
  const rank = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { count: s.length, p50: rank(0.5), p95: rank(0.95), max: s.at(-1)! };
}

function gitState(): { gitSha: string; gitDirty: boolean | null } {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
    return { gitSha: sha, gitDirty: dirty };
  } catch {
    return { gitSha: "unknown", gitDirty: null };
  }
}
