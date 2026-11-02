// Runs evaluation cases through the real case engine. Default: the FixtureModelAdapter,
// deterministic. Optionally (benchmark --mode vllm) with real-model adapters instead.
// Each case gets a fresh, isolated world and a fixed clock.
import type { Case, CaseRequest } from "../src/contracts.ts";
import { runCase, type EngineDeps } from "../src/case-engine.ts";
import { CommerceStore, REFUND_POLICY } from "../src/fixtures.ts";
import { SimulatedPaymentGateway } from "../src/gateway.ts";
import { FixtureModelAdapter, type ModelAdapter } from "../src/model-adapter.ts";
import { FixtureRequestUnderstandingAdapter, type RequestUnderstandingAdapter } from "../src/request-understanding.ts";
import type { EvalCase, LoadedDataset } from "./dataset.ts";
import { computeMetrics, METRIC_DEFINITIONS, score, type ActualOutcome, type ScoredCase } from "./metrics.ts";

export const EVAL_NOW = new Date("2026-10-05T12:00:00.000Z");
const MODEL_TIMEOUT_MS = 1000;

function buildStore(ec: EvalCase): CommerceStore {
  const at = (minutesAgo: number) => new Date(EVAL_NOW.getTime() - minutesAgo * 60_000).toISOString();
  const store = new CommerceStore();
  const w = ec.world;
  for (const c of w.customers) store.addCustomer(c);
  for (const o of w.orders) store.addOrder({ ...o, createdAt: at(1500) });
  for (const { minutesAgo, ...t } of w.transactions) store.addTransaction({ ...t, refundedMinor: 0, createdAt: at(minutesAgo) });
  for (const { minutesAgo, ...r } of w.refunds) store.recordRefund({ ...r, status: "SUCCEEDED", createdAt: at(minutesAgo) });
  return store;
}

/** Adapters to evaluate instead of the fixtures (e.g. vLLM). Never mixed with fixture adapters. */
export interface EvalAdapters {
  understanding: RequestUnderstandingAdapter;
  model: ModelAdapter;
  modelTimeoutMs: number;
}

// Dataset cases with model.kind "raw" stay scripted in every mode: they test the
// policy gate against a specific hostile proposal, not the model.
export const SCRIPTED_MODEL_ADAPTER_ID = "scripted-dataset-output";

function buildModel(ec: EvalCase, store: CommerceStore, base: ModelAdapter): ModelAdapter {
  const midflight = ec.setup.midflightRefund;
  const output = ec.model.kind === "raw" ? ec.model.output : null;
  if (output === null && !midflight) return base;
  return {
    id: output === null ? base.id : SCRIPTED_MODEL_ADAPTER_ID,
    propose: async (input, signal) => {
      // Simulates another actor changing payment state after the evidence snapshot.
      if (midflight) {
        const tx = store.getTransaction(midflight.transactionId)!;
        store.recordRefund({
          id: `RF-MIDFLIGHT-${midflight.transactionId}`,
          transactionId: midflight.transactionId,
          amountMinor: midflight.amountMinor,
          currency: tx.currency,
          status: "SUCCEEDED",
          idempotencyKey: `other-agent-${midflight.transactionId}`,
          createdAt: EVAL_NOW.toISOString(),
        });
      }
      return output ?? base.propose(input, signal);
    },
  };
}

export async function runEvalCase(
  ec: EvalCase,
  adapters: EvalAdapters | null = null,
  observe?: (c: Case) => void,
): Promise<ActualOutcome> {
  const store = buildStore(ec);
  const clock = () => EVAL_NOW;
  const gateway = new SimulatedPaymentGateway(store, clock);
  const deps = (model: ModelAdapter): EngineDeps => ({
    store,
    gateway,
    understanding: adapters?.understanding ?? new FixtureRequestUnderstandingAdapter(),
    model,
    policy: REFUND_POLICY,
    permissions: { autoRefund: true },
    clock,
    modelTimeoutMs: adapters?.modelTimeoutMs ?? MODEL_TIMEOUT_MS,
  });
  const baseModel = (): ModelAdapter => adapters?.model ?? new FixtureModelAdapter();
  const request: CaseRequest = ec.request;

  // Earlier identical submissions (default model, no faults) are setup, not measured.
  for (let i = 0; i < (ec.setup.priorSubmissions ?? 0); i++) await runCase(request, deps(baseModel()));

  const txIds = ec.world.transactions.map((t) => t.id);
  const before = new Set(store.refundsForTransactions(txIds).map((r) => r.id));
  gateway.nextFault = ec.setup.gatewayFault ?? null;

  const c = await runCase(request, deps(buildModel(ec, store, baseModel())));
  observe?.(c);

  const moneyMoved = store
    .refundsForTransactions(txIds)
    .filter((r) => !before.has(r.id) && !r.id.startsWith("RF-MIDFLIGHT-"))
    .map((r) => ({ transactionId: r.transactionId, amountMinor: r.amountMinor }))
    .toSorted((a, b) => a.transactionId.localeCompare(b.transactionId));
  const states = c.audit.filter((e) => e.type === "STATE_TRANSITION").map((e) => e.to);

  return {
    finalState: c.state,
    moneyMoved,
    reachedExecuting: states.includes("EXECUTING"),
    actionStatus: c.action?.status ?? null,
    reachedVerifying: states.includes("VERIFYING"),
    verified: c.verification?.verified ?? null,
    reasons: c.reasons.map((r) =>
      r.code === "POLICY_DENIED" || r.code === "STALE_EVIDENCE" ? `${r.code}:${r.detail.split(":")[0]}` : r.code,
    ),
  };
}

export async function runBenchmark(
  loaded: LoadedDataset,
  opts: { adapters?: EvalAdapters; observe?: (caseId: string, c: Case) => void } = {},
) {
  const { dataset, sha256 } = loaded;
  const cases: ScoredCase[] = [];
  for (const ec of dataset.cases) {
    const actual = await runEvalCase(ec, opts.adapters ?? null, opts.observe && ((c) => opts.observe!(ec.id, c)));
    cases.push({ id: ec.id, category: ec.category, expected: ec.expected, actual, scored: score(ec.expected, actual) });
  }
  const byCategory = Object.fromEntries(
    ["STRAIGHTFORWARD", "AMBIGUOUS", "CONTRADICTORY", "ADVERSARIAL_EDGE"].map((cat) => {
      const xs = cases.filter((x) => x.category === cat);
      return [cat, { total: xs.length, passed: xs.filter((x) => x.scored.pass).length, unsafe: xs.filter((x) => x.scored.unsafe).length }];
    }),
  );
  const byId = new Map(dataset.cases.map((c) => [c.id, c]));
  return {
    benchmark: {
      datasetId: dataset.datasetId,
      datasetVersion: dataset.version,
      datasetSha256: sha256,
      system: "apps/api case engine",
      model: "FixtureModelAdapter (deliberately naive default responder; per-case raw output where the dataset specifies it)",
      payments: "SimulatedPaymentGateway (no real money)",
      data: "synthetic",
      evaluationClock: EVAL_NOW.toISOString(),
      notMeasured: ["latency", "business impact"],
    },
    definitions: METRIC_DEFINITIONS,
    metrics: computeMetrics(cases),
    byCategory,
    cases: cases.map((x) => ({
      id: x.id,
      category: x.category,
      title: byId.get(x.id)!.title,
      risk: byId.get(x.id)!.risk,
      expected: x.expected,
      actual: x.actual,
      classification: x.scored.classification,
      pass: x.scored.pass,
    })),
  };
}

export type BenchmarkReport = Awaited<ReturnType<typeof runBenchmark>>;
