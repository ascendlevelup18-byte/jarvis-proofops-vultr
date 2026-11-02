// Financial-action safety: replays, races and dishonest read-backs on the money path.
// Complements review-remediation.test.ts (two cases refunding *different* charges) and
// engine-hardening.test.ts (read-back that throws, retry after an uncertain commit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Case, Refund } from "../src/contracts.ts";
import { runCase, type EngineDeps } from "../src/case-engine.ts";
import { SCENARIOS } from "../src/fixtures.ts";
import type { PaymentGateway } from "../src/gateway.ts";
import { makeDeps, modelSaying, proposal, refunded, statePath } from "./helpers.ts";

const DUP = "CHARGE-48291-B";
const KEPT = "CHARGE-48291-A";
const refundsOn48291 = (deps: ReturnType<typeof makeDeps>) => deps.store.refundsForTransactions([KEPT, DUP]);

/** Commits after an await, like a real provider, so racing cases all pass revalidation first. */
function slowGateway(inner: PaymentGateway, ms = 15): PaymentGateway {
  return {
    refund: async (a) => {
      await sleep(ms);
      return inner.refund(a);
    },
    findRefund: (k) => inner.findRefund(k),
  };
}

/** Read-back that reports something other than what was committed. */
function lyingReadBack(inner: PaymentGateway, lie: (r: Refund) => Refund | null): PaymentGateway {
  return {
    refund: (a) => inner.refund(a),
    findRefund: async (k) => {
      const r = await inner.findRefund(k);
      return r ? lie(r) : r;
    },
  };
}

function assertNeverReportedAsSuccess(c: Case) {
  assert.notEqual(c.state, "RESOLVED", `case ${c.id} must not resolve`);
  assert.equal(c.verification?.verified ?? false, false);
}

describe("replays and races on the same charge", () => {
  test("two identical cases racing on one duplicate charge move money once", async () => {
    const deps = makeDeps();
    const d: EngineDeps = { ...deps, gateway: slowGateway(deps.gateway) };
    const [a, b] = await Promise.all([runCase(SCENARIOS.validDuplicate, d), runCase(SCENARIOS.validDuplicate, d)]);

    assert.ok(statePath(a).includes("EXECUTING") && statePath(b).includes("EXECUTING"), "the race must actually reach execution");
    assert.equal(refundsOn48291(deps).length, 1);
    assert.equal(refunded(deps, DUP), 8999);
    assert.equal(refunded(deps, KEPT), 0);
    // Exactly one case executed and resolves; the other replayed the same refund and closes without
    // claiming it (F-1, fixed 16 Oct 2026).
    assert.deepEqual([a.state, b.state].sort(), ["CLOSED_NO_ACTION", "RESOLVED"]);
    const [winner, replay] = a.state === "RESOLVED" ? [a, b] : [b, a];
    assert.equal(winner.action?.replayed, false);
    assert.equal(replay.action?.replayed, true);
    assert.equal(replay.reasons[0]?.code, "REFUND_ALREADY_EXECUTED");
    // Both read back the one refund that exists, and each names the id its own gateway call returned.
    assert.equal(winner.verification?.observedRefund?.id, winner.action?.providerRefundId);
    assert.equal(replay.verification?.observedRefund?.id, winner.action?.providerRefundId);
    assert.equal(replay.verification?.verified, true);
  });

  test("five concurrent identical cases: one refund, one RESOLVED, four replays that claim nothing", async () => {
    const deps = makeDeps();
    const d: EngineDeps = { ...deps, gateway: slowGateway(deps.gateway, 5) };
    const cases = await Promise.all(Array.from({ length: 5 }, () => runCase(SCENARIOS.validDuplicate, d)));
    assert.equal(refundsOn48291(deps).length, 1);
    assert.equal(refunded(deps, DUP), 8999);
    assert.equal(cases.filter((c) => c.state === "RESOLVED").length, 1);
    assert.equal(cases.filter((c) => c.state === "CLOSED_NO_ACTION" && c.action?.replayed === true).length, 4);
    // Counting what a dashboard should count: resolved cases and distinct new refunds agree.
    const newRefunds = new Set(cases.filter((c) => c.action?.status === "ACCEPTED" && !c.action.replayed).map((c) => c.action!.providerRefundId));
    assert.equal(newRefunds.size, 1);
  });

  test("audit records tell the truth about a replay", async () => {
    const deps = makeDeps();
    const d: EngineDeps = { ...deps, gateway: slowGateway(deps.gateway) };
    const cases = await Promise.all([runCase(SCENARIOS.validDuplicate, d), runCase(SCENARIOS.validDuplicate, d)]);
    const replay = cases.find((c) => c.action?.replayed)!;
    const attempted = replay.audit.find((e) => e.type === "ACTION_ATTEMPTED")!.data as { replayed?: boolean };
    assert.equal(attempted.replayed, true);
    assert.deepEqual(statePath(replay).slice(-3), ["EXECUTING", "VERIFYING", "CLOSED_NO_ACTION"]);
    for (const c of cases) assert.deepEqual(c.audit.map((e) => e.seq), c.audit.map((_, i) => i + 1));
  });

  test("conflicting concurrent requests (different charges) still move money once", async () => {
    const deps = makeDeps();
    const keepB = modelSaying(proposal({ refundTransactionId: KEPT, keepTransactionId: DUP }));
    const g = slowGateway(deps.gateway);
    const [a, b] = await Promise.all([
      runCase(SCENARIOS.validDuplicate, { ...deps, gateway: g }),
      runCase(SCENARIOS.validDuplicate, { ...deps, gateway: g, model: keepB }),
    ]);
    assert.equal(refundsOn48291(deps).length, 1);
    assert.equal(refunded(deps, KEPT)! + refunded(deps, DUP)!, 8999);
    assert.equal([a, b].filter((c) => c.state === "RESOLVED").length, 1);
  });

  test("a retry after a timeout that committed resolves once and replays nothing new", async () => {
    const deps = makeDeps();
    deps.gateway.nextFault = "TIMEOUT_AFTER_COMMIT";
    const first = await runCase(SCENARIOS.validDuplicate, deps);
    // The response was lost but read-back finds the committed refund, so the first case resolves.
    assert.equal(first.action?.status, "ERROR");
    assert.equal(first.state, "RESOLVED");
    const retry = await runCase(SCENARIOS.validDuplicate, deps);
    assert.equal(retry.state, "CLOSED_NO_ACTION");
    assert.equal(retry.action, null);
    assert.equal(refundsOn48291(deps).length, 1);
  });

  test("a timeout before commit is never reported as a refund", async () => {
    const deps = makeDeps();
    deps.gateway.nextFault = "TIMEOUT_BEFORE_COMMIT";
    const c = await runCase(SCENARIOS.validDuplicate, deps);
    assertNeverReportedAsSuccess(c);
    assert.equal(c.state, "FAILED");
    assert.equal(refundsOn48291(deps).length, 0);
  });

  test("a gateway that returns the wrong refund id is caught by read-back", async () => {
    const deps = makeDeps();
    const wrongId: PaymentGateway = {
      refund: async (a) => ({ ...(await deps.gateway.refund(a)), refundId: "RF-SOMEONE-ELSE" }),
      findRefund: (k) => deps.gateway.findRefund(k),
    };
    const c = await runCase(SCENARIOS.validDuplicate, { ...deps, gateway: wrongId });
    assertNeverReportedAsSuccess(c);
    assert.match(c.reasons[0]?.detail ?? "", /not the RF-SOMEONE-ELSE/);
  });

  test("idempotency lives in the store: a second world does not know the first world's refund (documented limit)", async () => {
    // Each public demo request gets a fresh synthetic world, so repeats there are independent by design.
    // A real deployment needs durable, shared idempotency keys across workers (see SECURITY_REVIEW.md).
    const one = makeDeps();
    const two = makeDeps();
    await runCase(SCENARIOS.validDuplicate, one);
    const c = await runCase(SCENARIOS.validDuplicate, two);
    assert.equal(c.state, "RESOLVED");
    assert.equal(refundsOn48291(one).length, 1);
    assert.equal(refundsOn48291(two).length, 1);
  });

  test("replaying a resolved request afterwards refunds nothing more", async () => {
    const deps = makeDeps();
    const first = await runCase(SCENARIOS.validDuplicate, deps);
    assert.equal(first.state, "RESOLVED");
    for (let i = 0; i < 3; i++) {
      const again = await runCase(SCENARIOS.validDuplicate, deps);
      assert.notEqual(again.state, "RESOLVED", `replay ${i + 1} must not resolve a second time`);
      assert.equal(again.action, null, `replay ${i + 1} must not execute`);
    }
    assert.equal(refundsOn48291(deps).length, 1);
    assert.equal(refunded(deps, DUP), 8999);
  });
});

describe("verification integrity: a dishonest or empty read-back is never success", () => {
  const variants: [string, (r: Refund) => Refund | null][] = [
    ["amount differs by one cent", (r) => ({ ...r, amountMinor: r.amountMinor - 1 })],
    ["different transaction", (r) => ({ ...r, transactionId: KEPT })],
    ["different currency", (r) => ({ ...r, currency: "EUR" })],
    ["refund not succeeded", (r) => ({ ...r, status: "PENDING" as Refund["status"] })],
    ["refund missing", () => null],
  ];
  for (const [name, lie] of variants) {
    test(`read-back with ${name}: not RESOLVED, reason recorded, single refund at most`, async () => {
      const deps = makeDeps();
      const c = await runCase(SCENARIOS.validDuplicate, { ...deps, gateway: lyingReadBack(deps.gateway, lie) });
      assert.ok(statePath(c).includes("VERIFYING"), "the case must reach verification");
      assertNeverReportedAsSuccess(c);
      assert.ok(c.reasons.length > 0, "an unverified case must say why");
      assert.ok(refundsOn48291(deps).length <= 1);
    });
  }

  test("a gateway error is never reported as a refund", async () => {
    const deps = makeDeps();
    const failing: PaymentGateway = {
      refund: async () => {
        throw new Error("provider: declined");
      },
      findRefund: async () => null,
    };
    const c = await runCase(SCENARIOS.validDuplicate, { ...deps, gateway: failing });
    assertNeverReportedAsSuccess(c);
    assert.equal(refunded(deps, DUP), 0);
  });
});

describe("unsafe requests never reach the gateway", () => {
  for (const [name, req] of [
    ["adversarial $5,000 demand", SCENARIOS.promptInjection],
    ["contradicted amount", SCENARIOS.conflictingAmount],
    ["already refunded", SCENARIOS.alreadyRefunded],
  ] as const) {
    test(`${name}: zero gateway calls`, async () => {
      const deps = makeDeps();
      let calls = 0;
      const counting: PaymentGateway = {
        refund: async (a) => {
          calls++;
          return deps.gateway.refund(a);
        },
        findRefund: (k) => deps.gateway.findRefund(k),
      };
      const c = await runCase(req, { ...deps, gateway: counting });
      assert.equal(calls, 0);
      assert.equal(c.action, null);
      assert.ok(["ESCALATED", "CLOSED_NO_ACTION"].includes(c.state), c.state);
    });
  }
});
