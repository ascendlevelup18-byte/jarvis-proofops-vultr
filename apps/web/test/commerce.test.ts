// Analytics, Orders and Inbox derivations over REAL cases (real ingress + engine, fixture AI,
// simulated gateway) and the real demo-store seed. Guards: nothing is invented, a blocked or
// unverified refund is never shown as completed, internal Copilot data stays separate.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { demoStoreSnapshot } from "../../api/src/demo-store.ts";
import type { Case } from "../src/lib/case-types.ts";
import {
  buildInboxThreads,
  buildOrderRows,
  bucketMinutesFor,
  copilotBrief,
  deriveAnalytics,
  filterHistory,
  filterOrderRows,
  filterThreads,
  paymentStateOf,
} from "../src/lib/commerce.ts";
import type { DemoStoreSnapshot } from "../src/lib/demo-store.ts";
import { appendSessionCase, type SessionCaseEntry } from "../src/lib/session-store.ts";
import { demoCase, failedVerificationCase, providerFailureCase } from "./real-cases.ts";

const snapshot = () => JSON.parse(JSON.stringify(demoStoreSnapshot(() => new Date("2026-10-13T12:00:00Z")))) as DemoStoreSnapshot;

function session(items: { c: Case; source?: "operations" | "storefront"; at?: string }[]): SessionCaseEntry[] {
  let h: SessionCaseEntry[] = [];
  for (const { c, source, at } of items) {
    h = appendSessionCase(h, c, { source });
    if (at) h[0] = { ...h[0], submittedAt: at };
  }
  return h;
}

describe("analytics", () => {
  test("empty session yields zeros and no rate, not invented figures", () => {
    const a = deriveAnalytics([]);
    assert.equal(a.total, 0);
    assert.equal(a.autonomousRate, null);
    assert.deepEqual(a.verifiedRefundMinor, {});
    assert.deepEqual(a.volume, []);
    assert.deepEqual(a.aiCalls, []);
  });

  test("outcomes, verified refund total and blocked proposals come from the case records", async () => {
    const h = session([
      { c: await demoCase("valid-duplicate"), source: "storefront" },
      { c: await demoCase("prompt-injection"), source: "storefront" },
      { c: await demoCase("conflicting-amount") },
      { c: await demoCase("already-refunded") },
    ]);
    const a = deriveAnalytics(h);
    assert.deepEqual(a.outcomes, { resolved: 1, escalated: 2, closed: 1, failed: 0 });
    assert.deepEqual(a.verifiedRefundMinor, { USD: 8999 });
    assert.equal(a.proposalsBlocked, 2);
    assert.deepEqual(a.execution, { attempted: 1, verified: 1, unverified: 0 });
    assert.equal(a.autonomousRate, 0.5);
    // Two AI stages, each called once per case, read from the audit trail.
    assert.deepEqual(a.aiCalls.map((s) => [s.stage, s.adapter, s.calls]).sort(), [
      ["Decision", "fixture-model", 4],
      ["Understanding", "fixture-understanding", 4],
    ]);
    assert.equal(a.activity.length, 4);
  });

  test("an executed but unverified refund is not counted as refunded", async () => {
    const a = deriveAnalytics(session([{ c: await failedVerificationCase() }]));
    assert.deepEqual(a.verifiedRefundMinor, {});
    assert.equal(a.outcomes.resolved, 0);
    assert.equal(a.execution.unverified, 1);
    assert.match(a.activity[0].summary, /no refund confirmed/);
  });

  test("source and date filters", async () => {
    const now = new Date("2026-10-12T12:30:00Z");
    const h = session([
      { c: await demoCase("valid-duplicate"), source: "storefront", at: "2026-10-12T12:29:00Z" },
      { c: await demoCase("prompt-injection"), source: "operations", at: "2026-10-12T12:00:00Z" },
    ]);
    assert.equal(filterHistory(h, "all", "15m", now).length, 1);
    assert.equal(filterHistory(h, "all", "1h", now).length, 2);
    assert.equal(filterHistory(h, "storefront", "session", now).length, 1);
    assert.equal(filterHistory(h, "operations", "15m", now).length, 0);
  });

  test("volume buckets cover the span with no gaps", async () => {
    const h = session([
      { c: await demoCase("valid-duplicate"), at: "2026-10-12T12:00:10Z" },
      { c: await demoCase("prompt-injection"), at: "2026-10-12T12:03:20Z" },
    ]);
    const a = deriveAnalytics(h);
    assert.equal(a.bucketMinutes, 1);
    assert.equal(a.volume.length, 4);
    assert.equal(a.volume[0].resolved, 1);
    assert.equal(a.volume[3].escalated, 1);
    assert.equal(bucketMinutesFor(2 * 3_600_000), 30);
  });
});

describe("orders", () => {
  test("seed payment states are read from the charges", () => {
    const s = snapshot();
    assert.deepEqual(
      s.orders.map((o) => paymentStateOf(o)),
      ["Charged twice", "Charged twice", "Paid, extra charge refunded", "Charged twice"],
    );
  });

  test("rows join the latest session case per order; no case means no claims", async () => {
    const h = session([
      { c: await demoCase("valid-duplicate") },
      { c: await demoCase("prompt-injection"), source: "storefront" },
    ]);
    const rows = buildOrderRows(snapshot(), h);
    const by = Object.fromEntries(rows.map((r) => [r.order.orderId, r]));
    assert.equal(by["48291"].refundState, "Refunded by JARVIS (simulated)");
    assert.equal(by["48291"].verification, "Verified");
    assert.equal(by["48294"].refundState, "Refund blocked");
    assert.equal(by["48294"].verification, "Not executed");
    assert.equal(by["48292"].latestCase, null);
    assert.equal(by["48292"].refundState, "None");
    assert.equal(by["48293"].refundState, "Refunded before JARVIS");
  });

  test("an unverified refund is shown as not confirmed, never as refunded", async () => {
    const rows = buildOrderRows(snapshot(), session([{ c: await failedVerificationCase() }]));
    const r = rows.find((x) => x.order.orderId === "48291")!;
    assert.equal(r.refundState, "Refund not confirmed");
    assert.equal(r.verification, "Not verified");
    assert.equal(filterOrderRows(rows, "", "refunded").some((x) => x.order.orderId === "48291"), false);
  });

  test("search and status filters", async () => {
    const rows = buildOrderRows(snapshot(), session([{ c: await demoCase("conflicting-amount") }]));
    assert.deepEqual(filterOrderRows(rows, "#48293", "all").map((r) => r.order.orderId), ["48293"]);
    assert.deepEqual(filterOrderRows(rows, "ben", "all").map((r) => r.order.orderId), ["48292"]);
    assert.deepEqual(filterOrderRows(rows, "", "needs-review").map((r) => r.order.orderId), ["48292"]);
    assert.equal(filterOrderRows(rows, "", "no-case").length, 3);
    assert.deepEqual(filterOrderRows(rows, "", "refunded").map((r) => r.order.orderId), ["48293"]);
  });
});

describe("inbox", () => {
  test("no session cases means no conversations", () => {
    assert.deepEqual(buildInboxThreads([], snapshot()), []);
  });

  test("messages are exactly the recorded request plus the outcome-derived reply", async () => {
    const c = await demoCase("prompt-injection");
    const [t] = buildInboxThreads(session([{ c, source: "storefront" }]), snapshot());
    assert.equal(t.customerName, "Dee Placeholder");
    assert.equal(t.status, "Needs human");
    assert.equal(t.messages.length, 2);
    assert.deepEqual(t.messages[0], { kind: "customer", caseId: c.id, at: c.createdAt, text: c.request.message, via: "storefront" });
    assert.equal(t.messages[1].kind, "reply");
    if (t.messages[1].kind === "reply") {
      assert.equal(t.messages[1].delivered, true);
      assert.match(t.messages[1].reply.body, /No refund has been made yet/);
    }
  });

  test("replies to console-run cases are marked as not delivered", async () => {
    const [t] = buildInboxThreads(session([{ c: await demoCase("valid-duplicate") }]), snapshot());
    assert.equal(t.messages[1].kind === "reply" && t.messages[1].delivered, false);
  });

  test("repeat requests on one order stay in one thread; filters and search work", async () => {
    const h = session([
      { c: await demoCase("valid-duplicate"), source: "storefront" },
      { c: await demoCase("valid-duplicate"), source: "storefront" },
      { c: await demoCase("conflicting-amount"), source: "storefront" },
    ]);
    const threads = buildInboxThreads(h, snapshot());
    assert.equal(threads.length, 2);
    assert.equal(threads.find((t) => t.orderId === "48291")!.messages.length, 4);
    assert.deepEqual(filterThreads(threads, "", "needs-human").map((t) => t.orderId), ["48292"]);
    assert.deepEqual(filterThreads(threads, "ada", "all").map((t) => t.orderId), ["48291"]);
    assert.deepEqual(filterThreads(threads, "", "closed"), []);
  });

  test("copilot: escalated case requires a human and cites the failed check and policy sections", async () => {
    const b = copilotBrief(await demoCase("conflicting-amount"));
    assert.equal(b.proposal?.action, "REFUND_DUPLICATE");
    assert.equal(b.approval.required, true);
    assert.equal(b.verification, "Not executed");
    assert.deepEqual(b.checks.failed.map((f) => f.rule), ["NO_CONTRADICTIONS"]);
    assert.ok(b.policyRefs.length > 0 && b.policyRefs.every((r) => /^DUP-\d$/.test(r.id) && r.text.length > 0));
  });

  test("copilot: resolved case is verified and needs no approval; failures always need a human", async () => {
    const ok = copilotBrief(await demoCase("valid-duplicate"));
    assert.equal(ok.approval.required, false);
    assert.equal(ok.verification, "Verified");
    const unverified = copilotBrief(await failedVerificationCase());
    assert.equal(unverified.approval.required, true);
    assert.equal(unverified.verification, "Not verified");
    const provider = copilotBrief(await providerFailureCase());
    assert.equal(provider.approval.required, true);
    assert.equal(provider.proposal, null);
  });
});
