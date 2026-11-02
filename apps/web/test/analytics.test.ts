// Analytics aggregation over REAL cases (real ingress + engine) and the labelled sample set.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aiStats,
  compare,
  drill,
  granularityFor,
  inWindow,
  rangeWindow,
  recordFromEntry,
  startOfDay,
  summarize,
  timeSeries,
  type AnalyticsRecord,
} from "../src/lib/analytics.ts";
import { SAMPLE_PERIOD_END, sampleRecords } from "../src/lib/sample-analytics.ts";
import { appendSessionCase, type SessionCaseEntry } from "../src/lib/session-store.ts";
import type { Case } from "../src/lib/case-types.ts";
import { demoCase, failedVerificationCase, providerFailureCase } from "./real-cases.ts";

const NOW = Date.parse("2026-10-12T15:00:00Z");

async function records(items: [Case, string, ("storefront" | "operations")?][]): Promise<AnalyticsRecord[]> {
  let h: SessionCaseEntry[] = [];
  for (const [c, at, source] of items) {
    h = appendSessionCase(h, c, { source });
    h[0] = { ...h[0], submittedAt: at };
  }
  return h.map(recordFromEntry);
}

describe("analytics: summary", () => {
  test("empty dataset: zeros, no rates, no comparison", () => {
    const s = summarize([]);
    assert.equal(s.cases, 0);
    assert.equal(s.autonomousRate, null);
    assert.equal(s.escalationRate, null);
    assert.deepEqual(s.verifiedRefundMinor, {});
    const w = rangeWindow("7d", NOW, []);
    assert.equal(compare([], w, (x) => x.cases), null);
    assert.ok(timeSeries([], w, "day").every((b) => b.total === 0));
  });

  test("mixed outcomes, refunds and review counts come from the records", async () => {
    const r = await records([
      [await demoCase("valid-duplicate"), "2026-10-12T14:00:00Z", "storefront"],
      [await demoCase("prompt-injection"), "2026-10-12T14:01:00Z", "storefront"],
      [await demoCase("already-refunded"), "2026-10-12T14:02:00Z"],
      [await failedVerificationCase(), "2026-10-12T14:03:00Z"],
      [await providerFailureCase(), "2026-10-12T14:04:00Z"],
    ]);
    const s = summarize(r);
    assert.deepEqual(
      { resolved: s.outcomes.resolved, escalated: s.outcomes.escalated, closed: s.outcomes.closed, failed: s.outcomes.failed },
      { resolved: 1, escalated: 1, closed: 1, failed: 2 },
    );
    assert.deepEqual(s.refunds, { verified: 1, blocked: 1, "not-confirmed": 1, "not-needed": 1, none: 1 });
    // Only the read-back-verified refund is counted as money refunded.
    assert.deepEqual(s.verifiedRefundMinor, { USD: 8999 });
    assert.equal(s.pendingReview, 3);
    assert.equal(s.autonomousRate, 2 / 5);
    assert.equal(s.storefront, 2);
    assert.ok(s.aiErrors >= 1, "the provider failure is counted as a failed AI call");
  });
});

describe("analytics: time filters", () => {
  test("windows and previous periods", () => {
    const today = rangeWindow("today", NOW, []);
    assert.equal(today.start, startOfDay(NOW));
    assert.deepEqual(today.previous, { start: today.start - (NOW - today.start), end: today.start });
    const w7 = rangeWindow("7d", NOW, []);
    assert.equal(NOW - w7.start, 7 * 86_400_000);
    assert.equal(rangeWindow("all", NOW, []).previous, null);
  });

  test("previous-period comparison only when the earlier window holds records", async () => {
    const c = await demoCase("valid-duplicate");
    const recent = await records([[c, "2026-10-11T10:00:00Z"]]);
    const w = rangeWindow("7d", NOW, recent);
    assert.equal(compare(recent, w, (x) => x.cases), null);
    const both = await records([
      [c, "2026-10-11T10:00:00Z"],
      [await demoCase("prompt-injection"), "2026-10-11T11:00:00Z"],
      [await demoCase("conflicting-amount"), "2026-10-02T10:00:00Z"],
    ]);
    assert.deepEqual(compare(both, w, (x) => x.cases), { current: 2, previous: 1, change: 1 });
  });

  test("range filtering excludes records outside the window", async () => {
    const r = await records([
      [await demoCase("valid-duplicate"), "2026-10-12T14:00:00Z"],
      [await demoCase("prompt-injection"), "2026-09-01T14:00:00Z"],
    ]);
    assert.equal(r.filter((x) => inWindow(x, rangeWindow("7d", NOW, r))).length, 1);
    assert.equal(r.filter((x) => inWindow(x, rangeWindow("90d", NOW, r))).length, 2);
    assert.equal(r.filter((x) => inWindow(x, rangeWindow("all", NOW, r))).length, 2);
  });

  test("time series covers the whole window with contiguous buckets", async () => {
    const r = await records([
      [await demoCase("valid-duplicate"), "2026-10-12T14:00:00Z"],
      [await demoCase("prompt-injection"), "2026-10-10T09:00:00Z"],
    ]);
    const w = rangeWindow("7d", NOW, r);
    const b = timeSeries(r, w, granularityFor("7d", w));
    assert.ok(b.length >= 7 && b.length <= 8);
    assert.equal(b.reduce((n, x) => n + x.total, 0), 2);
    for (let i = 1; i < b.length; i++) assert.equal(b[i].start, b[i - 1].end);
    assert.equal(granularityFor("today", w), "hour");
    assert.equal(granularityFor("90d", w), "week");
    // A session spanning minutes uses 5-minute buckets under "all".
    assert.equal(granularityFor("all", { start: NOW - 600_000, end: NOW, previous: null }), "5min");
  });
});

describe("analytics: breakdowns and drill-down", () => {
  test("drill by outcome, refund outcome, source and review", async () => {
    const r = await records([
      [await demoCase("valid-duplicate"), "2026-10-12T14:00:00Z", "storefront"],
      [await demoCase("prompt-injection"), "2026-10-12T14:01:00Z", "storefront"],
      [await demoCase("conflicting-amount"), "2026-10-12T14:02:00Z"],
    ]);
    assert.deepEqual(drill(r, { outcome: "escalated" }).map((x) => x.orderId), ["48292", "48294"]);
    assert.deepEqual(drill(r, { refund: "verified" }).map((x) => x.orderId), ["48291"]);
    assert.equal(drill(r, { source: "storefront" }).length, 2);
    assert.equal(drill(r, { reviewOnly: true }).length, 2);
    assert.ok(drill(r, {}).every((x) => x.entry), "real records keep their case for evidence drill-down");
  });

  test("AI stats per stage and adapter, from the audit trail", async () => {
    const r = await records([
      [await demoCase("valid-duplicate"), "2026-10-12T14:00:00Z"],
      [await demoCase("prompt-injection"), "2026-10-12T14:01:00Z"],
    ]);
    const stats = aiStats(r);
    assert.deepEqual(stats.map((x) => [x.stage, x.adapter, x.calls, x.measured]).sort(), [
      ["Decision", "fixture-model", 2, 2],
      ["Understanding", "fixture-understanding", 2, 2],
    ]);
    assert.ok(stats.every((x) => x.avgMs !== null && x.p95Ms !== null));
  });
});

describe("analytics: sample data", () => {
  test("deterministic, labelled, separate, and never carries latency or real cases", () => {
    const a = sampleRecords();
    assert.ok(a.length > 90);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(sampleRecords())));
    assert.ok(a.every((r) => r.source === "sample" && r.id.startsWith("SAMPLE-") && !r.entry));
    assert.ok(a.every((r) => r.aiCalls.every((c) => c.latencyMs === null)));
    assert.ok(a.every((r) => Date.parse(r.at) <= SAMPLE_PERIOD_END));
    assert.ok(a.every((r) => (r.refund === "verified") === (r.refundMinor > 0)));
    assert.equal(aiStats(a).every((s) => s.avgMs === null), true);
  });

  test("no invented improvement: first and second half rates are close", () => {
    const a = sampleRecords();
    const mid = SAMPLE_PERIOD_END - 45 * 86_400_000;
    const rate = (xs: AnalyticsRecord[]) => summarize(xs).autonomousRate!;
    const first = rate(a.filter((r) => Date.parse(r.at) < mid));
    const second = rate(a.filter((r) => Date.parse(r.at) >= mid));
    assert.ok(Math.abs(first - second) < 0.2, `rates drift ${first} → ${second}`);
  });
});
