// Real cases for UI-logic tests: produced by the actual API ingress and case engine
// (fixture adapters, simulated gateway), then JSON round-tripped like an HTTP response.
// Nothing here is hand-written case data.
import { runCase, type EngineDeps } from "../../api/src/case-engine.ts";
import { REFUND_POLICY } from "../../api/src/fixtures.ts";
import { freshWorld, handleCaseRequest, PUBLIC_DEMOS, type DemoId } from "../../api/src/ingress.ts";
import { LocalInferenceLimiter } from "../../api/src/limits.ts";
import { FixtureModelAdapter } from "../../api/src/model-adapter.ts";
import { FixtureRequestUnderstandingAdapter } from "../../api/src/request-understanding.ts";
import type { Case } from "../src/lib/case-types.ts";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const clock = () => NOW;
const asJson = (c: unknown): Case => JSON.parse(JSON.stringify(c)) as Case;

/** One public demo through the real ingress guard (fresh world per run). */
export async function demoCase(id: DemoId): Promise<Case> {
  const r = await handleCaseRequest(
    { method: "POST", bodyText: JSON.stringify(PUBLIC_DEMOS[id]), authorization: undefined, clientKey: "web-test" },
    {
      aiMode: "fixture",
      understanding: new FixtureRequestUnderstandingAdapter(),
      model: new FixtureModelAdapter(),
      engineTimeoutMs: 1000,
      accessToken: null,
      limiter: new LocalInferenceLimiter({ maxConcurrent: 10, perClientPerMinute: 1000, dailyModelCallBudget: 1000 }),
      privilegedWorld: () => freshWorld(clock),
      clock,
    },
  );
  if (r.status !== 200) throw new Error(`demo ${id} returned ${r.status}`);
  return asJson(r.body);
}

function deps(over: Partial<EngineDeps> = {}): EngineDeps & ReturnType<typeof freshWorld> {
  const world = freshWorld(clock);
  return {
    ...world,
    understanding: new FixtureRequestUnderstandingAdapter(),
    model: new FixtureModelAdapter(),
    policy: REFUND_POLICY,
    permissions: { autoRefund: true },
    clock,
    modelTimeoutMs: 1000,
    ...over,
  };
}

/** Valid duplicate whose simulated gateway times out before committing: refund cannot be verified. */
export async function failedVerificationCase(): Promise<Case> {
  const d = deps();
  d.gateway.nextFault = "TIMEOUT_BEFORE_COMMIT";
  return asJson(await runCase(PUBLIC_DEMOS["valid-duplicate"], d));
}

/** Identical valid-duplicate requests racing in one world: one executes, the rest replay its refund. */
export async function racingDuplicateCases(n: number): Promise<Case[]> {
  const d = deps();
  const inner = d.gateway;
  const slow = {
    refund: async (a: Parameters<typeof inner.refund>[0]) => {
      await new Promise((r) => setTimeout(r, 10));
      return inner.refund(a);
    },
    findRefund: (k: string) => inner.findRefund(k),
  };
  const cases = await Promise.all(Array.from({ length: n }, () => runCase(PUBLIC_DEMOS["valid-duplicate"], { ...d, gateway: slow })));
  return cases.map(asJson);
}

/** Understanding provider throws (e.g. endpoint down). */
export async function providerFailureCase(): Promise<Case> {
  const failing = new FixtureRequestUnderstandingAdapter(() => {
    throw new Error("provider HTTP 503: upstream unavailable");
  });
  return asJson(await runCase(PUBLIC_DEMOS["valid-duplicate"], deps({ understanding: failing })));
}

/** Model returns prose instead of the proposal schema. */
export async function malformedProposalCase(): Promise<Case> {
  const prose = new FixtureModelAdapter(() => "Sure! I refunded it and marked it verified.");
  return asJson(await runCase(PUBLIC_DEMOS["valid-duplicate"], deps({ model: prose })));
}

/** Order that does not exist in the records: no evidence bundle. */
export async function missingEvidenceCase(): Promise<Case> {
  return asJson(
    await runCase({ customerId: "CUST-1001", orderId: "99999", message: "I was charged twice for order #99999." }, deps()),
  );
}
