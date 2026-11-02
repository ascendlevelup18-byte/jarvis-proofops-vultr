// JARVIS Automations: onboarding selection, demo-store connection, customer refund
// submission, merchant visibility and escalation, all against real backend code.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { demoStoreSnapshot } from "../../api/src/demo-store.ts";
import { AUTOMATION_MODULES, checkStoreDomain, operationalSelected, validateModuleSelection } from "../src/lib/automations.ts";
import type { Case } from "../src/lib/case-types.ts";
import { customerReply, describeOrderBalance, findOrder, refundRequestFor, type DemoStoreSnapshot } from "../src/lib/demo-store.ts";
import { presentsFalseSuccess } from "../src/lib/outcome-guards.ts";
import { appendSessionCase } from "../src/lib/session-store.ts";
import { demoCase, failedVerificationCase } from "./real-cases.ts";

const snapshot = () => JSON.parse(JSON.stringify(demoStoreSnapshot(() => new Date("2026-10-13T12:00:00Z")))) as DemoStoreSnapshot;

describe("onboarding", () => {
  test("only the refunds module is operational; every preview says what is missing", () => {
    assert.deepEqual(AUTOMATION_MODULES.filter((m) => m.status === "operational").map((m) => m.id), ["refunds"]);
    for (const m of AUTOMATION_MODULES.filter((x) => x.status === "preview")) assert.match(m.reality, /not (built|automated)/i);
    assert.equal(AUTOMATION_MODULES.length, 6);
  });

  test("selection validation", () => {
    assert.deepEqual(validateModuleSelection([]), { ok: false, error: "Select at least one automation" });
    assert.equal(validateModuleSelection(["refunds", "nope"]).ok, false);
    assert.deepEqual(validateModuleSelection(["refunds", "inventory"]), { ok: true });
    assert.deepEqual(operationalSelected(["inventory", "refunds"]).map((m) => m.id), ["refunds"]);
    assert.deepEqual(operationalSelected(["inventory"]), []);
  });

  test("a real store domain is validated but never connectable in this build", () => {
    const ok = checkStoreDomain("https://Shop.Example.com/products");
    assert.equal(ok.valid, true);
    assert.equal(ok.domain, "shop.example.com");
    assert.equal(ok.connectable, false);
    assert.match(ok.message, /not available in this build/);
    assert.equal(checkStoreDomain("not a domain").valid, false);
  });
});

describe("demo store connection and order lookup", () => {
  test("the connected demo store is the backend seed: four orders, real totals", () => {
    const s = snapshot();
    assert.equal(s.store.data, "synthetic");
    assert.equal(s.store.payments, "simulated");
    assert.equal(s.orders.length, 4);
    assert.equal(describeOrderBalance(findOrder(s, "#48291")!), "2 charges · net paid $179.98 for a $89.99 order");
    assert.equal(describeOrderBalance(findOrder(s, "48293")!), "2 charges · net paid $45.00 for a $45.00 order");
  });

  test("order lookup accepts common forms and rejects unknown orders", () => {
    const s = snapshot();
    for (const q of ["48291", "#48291", " order 48291 ", "Order #48291"]) assert.equal(findOrder(s, q)?.orderId, "48291", q);
    assert.equal(findOrder(s, "99999"), null);
  });
});

describe("customer refund submission → merchant visibility (real engine)", () => {
  test("valid duplicate: customer told refund issued only because the case is RESOLVED and verified", async () => {
    const c = await demoCase("valid-duplicate");
    const req = refundRequestFor(findOrder(snapshot(), "48291")!);
    assert.deepEqual(req, c.request);
    const reply = customerReply(c);
    assert.equal(reply.tone, "success");
    assert.equal(reply.title, "Refund of $89.99 issued");
    assert.match(reply.body, /simulated/);
    const history = appendSessionCase([], c, { scenarioTitle: "Storefront · order #48291", scenarioId: "valid-duplicate", source: "storefront" });
    assert.equal(history[0]?.source, "storefront");
    assert.equal(history[0]?.state, "RESOLVED");
  });

  test("escalation: conflicting and hostile requests tell the customer no refund was made", async () => {
    for (const id of ["conflicting-amount", "prompt-injection"] as const) {
      const c = await demoCase(id);
      const reply = customerReply(c);
      assert.equal(reply.tone, "review", id);
      assert.match(reply.body, /No refund has been made yet/);
      assert.equal(presentsFalseSuccess(c), false);
    }
  });

  test("already refunded and failed verification never claim a refund was issued", async () => {
    const closed = customerReply(await demoCase("already-refunded"));
    assert.equal(closed.tone, "info");
    assert.doesNotMatch(closed.title, /issued/);
    const failed = customerReply(await failedVerificationCase());
    assert.equal(failed.tone, "problem");
    assert.match(failed.body, /No refund has been confirmed/);
  });

  test("a RESOLVED-looking case without verified read-back is not described as a refund", async () => {
    const c = (await demoCase("valid-duplicate")) as Case;
    const tampered = { ...c, verification: { ...c.verification!, verified: false } };
    assert.notEqual(customerReply(tampered).tone, "success");
  });
});
