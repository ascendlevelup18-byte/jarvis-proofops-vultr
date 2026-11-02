// Racing identical requests: the UI and analytics must count one refund and one resolution,
// and describe the replays truthfully. Cases come from the real engine (real-cases.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { recordFromEntry, refundOutcomeOfCase, summarize } from "../src/lib/analytics.ts";
import { missionOutcome } from "../src/lib/command-center.ts";
import { lifecycleOf } from "../src/lib/commerce.ts";
import { appendSessionCase, type SessionCaseEntry } from "../src/lib/session-store.ts";
import { racingDuplicateCases } from "./real-cases.ts";

describe("replayed refunds in the console", () => {
  test("three racing requests: one verified refund, one resolution, two replays", async () => {
    const cases = await racingDuplicateCases(3);
    assert.equal(cases.filter((c) => c.state === "RESOLVED").length, 1);
    const replays = cases.filter((c) => c.action?.replayed === true);
    assert.equal(replays.length, 2);

    let history: SessionCaseEntry[] = [];
    for (const c of cases) history = appendSessionCase(history, c, { scenarioId: "valid-duplicate" });
    const s = summarize(history.map(recordFromEntry));
    assert.equal(s.cases, 3);
    assert.equal(s.refunds.verified, 1);
    assert.deepEqual(s.verifiedRefundMinor, { USD: 8999 });

    for (const r of replays) {
      assert.equal(r.state, "CLOSED_NO_ACTION");
      assert.equal(refundOutcomeOfCase(r), "not-needed");
      const outcome = missionOutcome(r);
      assert.equal(outcome.title, "Refund already executed");
      assert.match(outcome.detail, /moved no money/);
      const executed = lifecycleOf(r).find((s) => s.key === "EXECUTED")!;
      assert.equal(executed.reached, false);
      assert.match(executed.detail, /existing refund/);
    }
  });
});
