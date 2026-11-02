// Merchant workspace logic: deep-link routes, global search, order sorting, customers, and the
// Copilot control-plane ladder — over the real demo-store seed and real engine cases.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { demoStoreSnapshot } from "../../api/src/demo-store.ts";
import { buildOrderRows, customerRows, isOrderStatusFilter, lifecycleOf, progressionOf, sortOrderRows } from "../src/lib/commerce.ts";
import type { DemoStoreSnapshot } from "../src/lib/demo-store.ts";
import { formatRoute, parseRoute, type Route } from "../src/lib/routes.ts";
import { searchRecords } from "../src/lib/search.ts";
import { appendSessionCase, type SessionCaseEntry } from "../src/lib/session-store.ts";
import { NAV_ITEMS } from "../src/lib/system-truth.ts";
import { demoCase, failedVerificationCase } from "./real-cases.ts";

const snapshot = () => JSON.parse(JSON.stringify(demoStoreSnapshot(() => new Date("2026-10-13T12:00:00Z")))) as DemoStoreSnapshot;

describe("routes", () => {
  test("every nav page round-trips through its hash", () => {
    for (const n of NAV_ITEMS) {
      const r: Route = { surface: "merchant", nav: n.id };
      assert.deepEqual(parseRoute(formatRoute(r)), r, n.id);
    }
  });

  test("case, order and filter deep links; store and setup; unknown hashes", () => {
    assert.deepEqual(parseRoute("#/case/CASE-abc"), { surface: "merchant", nav: "cases", caseId: "CASE-abc" });
    assert.deepEqual(parseRoute("#/orders/48291"), { surface: "merchant", nav: "orders", orderId: "48291" });
    assert.deepEqual(parseRoute("#/orders?status=needs-review"), { surface: "merchant", nav: "orders", params: { status: "needs-review" } });
    assert.equal(formatRoute({ surface: "merchant", nav: "orders", params: { q: "CUST-1002" } }), "#/orders?q=CUST-1002");
    assert.deepEqual(parseRoute("#store"), { surface: "store" });
    assert.deepEqual(parseRoute("#setup"), { surface: "setup" });
    assert.equal(parseRoute("#/nope"), null);
    assert.equal(parseRoute(""), null);
    assert.equal(isOrderStatusFilter("needs-review"), true);
    assert.equal(isOrderStatusFilter("<script>"), false);
  });
});

describe("global search", () => {
  test("finds orders, customers and recorded cases only", async () => {
    const c = await demoCase("valid-duplicate");
    const h = appendSessionCase([], c, {});
    assert.deepEqual(searchRecords("#48293", snapshot(), h).map((x) => x.kind + ":" + x.label), ["Order:#48293"]);
    assert.deepEqual(searchRecords("ben", snapshot(), h).map((x) => x.kind), ["Customer"]);
    assert.deepEqual(searchRecords(c.id.slice(0, 12), snapshot(), h)[0].route, { surface: "merchant", nav: "cases", caseId: c.id });
    assert.deepEqual(searchRecords("   ", snapshot(), h), []);
    assert.deepEqual(searchRecords("zzz", snapshot(), h), []);
  });
});

describe("orders and customers", () => {
  test("sorting by value, customer and order is stable and reversible", async () => {
    const rows = buildOrderRows(snapshot(), []);
    assert.deepEqual(sortOrderRows(rows, "value", "desc").map((r) => r.order.orderId), ["48292", "48291", "48294", "48293"]);
    assert.deepEqual(sortOrderRows(rows, "value", "asc").map((r) => r.order.orderId), ["48293", "48294", "48291", "48292"]);
    assert.deepEqual(sortOrderRows(rows, "customer", "asc").map((r) => r.order.customerName), ["Ada Fictional", "Ben Example", "Cy Sample", "Dee Placeholder"]);
    assert.deepEqual(sortOrderRows(rows, "order", "desc").map((r) => r.order.orderId), ["48294", "48293", "48292", "48291"]);
  });

  test("customers come from the seed and count only their own recorded cases", async () => {
    let h: SessionCaseEntry[] = [];
    h = appendSessionCase(h, await demoCase("prompt-injection"), { source: "storefront" });
    h = appendSessionCase(h, await demoCase("valid-duplicate"), {});
    const rows = customerRows(snapshot(), h);
    assert.equal(rows.length, 4);
    const dee = rows.find((r) => r.customerId === "CUST-1004")!;
    assert.deepEqual([dee.cases, dee.pendingReview, dee.latest?.state], [1, 1, "ESCALATED"]);
    const cy = rows.find((r) => r.customerId === "CUST-1003")!;
    assert.deepEqual([cy.cases, cy.latest], [0, null]);
  });
});

describe("copilot control-plane ladder", () => {
  const reached = (c: Parameters<typeof lifecycleOf>[0]) => Object.fromEntries(lifecycleOf(c).map((s) => [s.key, s.reached]));

  test("verified refund: proposed, approved, executed, verified; not escalated", async () => {
    assert.deepEqual(reached(await demoCase("valid-duplicate")), { PROPOSED: true, APPROVED: true, EXECUTED: true, VERIFIED: true, ESCALATED: false });
  });

  test("unsafe request: proposed but never approved, executed or verified; escalated", async () => {
    assert.deepEqual(reached(await demoCase("prompt-injection")), { PROPOSED: true, APPROVED: false, EXECUTED: false, VERIFIED: false, ESCALATED: true });
  });

  test("executed but unconfirmed refund is never shown as verified", async () => {
    const r = reached(await failedVerificationCase());
    assert.equal(r.APPROVED, true);
    assert.equal(r.VERIFIED, false);
    assert.equal(r.ESCALATED, true);
  });

  test("already refunded: nothing approved for execution, nothing escalated", async () => {
    const c = await demoCase("already-refunded");
    const r = reached(c);
    assert.equal(r.EXECUTED, false);
    assert.equal(r.ESCALATED, false);
    assert.deepEqual(progressionOf(c).at(-1)?.state, "CLOSED_NO_ACTION");
  });
});
