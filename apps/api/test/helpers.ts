import type { Case, CaseState } from "../src/contracts.ts";
import type { EngineDeps } from "../src/case-engine.ts";
import { CommerceStore, REFUND_POLICY, seedFixtures } from "../src/fixtures.ts";
import { SimulatedPaymentGateway } from "../src/gateway.ts";
import type { CaseIngress } from "../src/ingress.ts";
import { LocalInferenceLimiter } from "../src/limits.ts";
import { FixtureModelAdapter, type ModelAdapter } from "../src/model-adapter.ts";
import { FixtureRequestUnderstandingAdapter, type RequestUnderstandingAdapter } from "../src/request-understanding.ts";

export const NOW = new Date("2026-10-05T12:00:00.000Z");

export interface TestDeps extends EngineDeps {
  gateway: SimulatedPaymentGateway;
}

export function makeDeps(
  opts: {
    model?: ModelAdapter;
    understanding?: RequestUnderstandingAdapter;
    autoRefund?: boolean;
    modelTimeoutMs?: number;
  } = {},
): TestDeps {
  const clock = () => NOW;
  const store = new CommerceStore();
  seedFixtures(store, NOW);
  return {
    store,
    gateway: new SimulatedPaymentGateway(store, clock),
    understanding: opts.understanding ?? new FixtureRequestUnderstandingAdapter(),
    model: opts.model ?? new FixtureModelAdapter(),
    policy: REFUND_POLICY,
    permissions: { autoRefund: opts.autoRefund ?? true },
    clock,
    modelTimeoutMs: opts.modelTimeoutMs ?? 1000,
  };
}

// A model that returns exactly this raw output.
export const modelSaying = (raw: string | ((input: Parameters<ModelAdapter["propose"]>[0]) => string)) =>
  new FixtureModelAdapter((input) => (typeof raw === "function" ? raw(input) : raw));

// An understanding adapter that returns exactly this raw output.
export const understandingSaying = (raw: string) => new FixtureRequestUnderstandingAdapter(() => raw);

export const proposal = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    action: "REFUND_DUPLICATE",
    refundTransactionId: "CHARGE-48291-B",
    keepTransactionId: "CHARGE-48291-A",
    evidenceRefs: ["48291", "CHARGE-48291-A", "CHARGE-48291-B", "DUP-1"],
    riskFlags: [],
    confidence: 0.9,
    rationale: "duplicate",
    ...over,
  });

export const statePath = (c: Case): CaseState[] =>
  c.audit.filter((e) => e.type === "STATE_TRANSITION").map((e) => e.to!);

export const reasonDetails = (c: Case): string => c.reasons.map((r) => `${r.code} ${r.detail}`).join(" | ");

export const refunded = (deps: TestDeps, txId: string) => deps.store.getTransaction(txId)?.refundedMinor;

// Ingress over test deps: fixture-mode limits generous enough never to interfere.
export const TEST_TOKEN = "test-token-0123456789abcdef";
export function ingressFor(deps: TestDeps, over: Partial<CaseIngress> = {}): CaseIngress {
  return {
    aiMode: "fixture",
    understanding: deps.understanding,
    model: deps.model,
    engineTimeoutMs: deps.modelTimeoutMs,
    accessToken: TEST_TOKEN,
    limiter: new LocalInferenceLimiter({ maxConcurrent: 100, perClientPerMinute: 1000, dailyModelCallBudget: 100_000 }),
    privilegedWorld: () => ({ store: deps.store, gateway: deps.gateway }),
    clock: deps.clock,
    ...over,
  };
}
