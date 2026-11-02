// Demo store: read-only snapshot of the real seed, served on every ingress, whose support
// requests are exactly the public demo requests (so they pass the access guard unchanged).
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { GET as vercelDemoStore } from "../../../api/demo-store.ts";
import netlifyDemoStore from "../../../netlify/functions/demo-store.ts";
import type { Case } from "../src/contracts.ts";
import { demoStoreSnapshot } from "../src/demo-store.ts";
import { PUBLIC_DEMOS } from "../src/ingress.ts";
import { createApp } from "../src/server.ts";
import { ingressFor, makeDeps, NOW } from "./helpers.ts";

describe("demo store snapshot", () => {
  test("lists the four seeded orders with real totals, charges and seeded refunds", () => {
    const s = demoStoreSnapshot(() => NOW);
    assert.equal(s.store.data, "synthetic");
    assert.equal(s.store.payments, "simulated");
    assert.deepEqual(
      s.orders.map((o) => [o.orderId, o.customerId, o.totalMinor, o.charges.length]),
      [
        ["48291", "CUST-1001", 8999, 2],
        ["48292", "CUST-1002", 18000, 2],
        ["48293", "CUST-1003", 4500, 2],
        ["48294", "CUST-1004", 6450, 2],
      ],
    );
    const o3 = s.orders.find((o) => o.orderId === "48293")!;
    assert.equal(o3.charges.find((c) => c.id === "CHARGE-48293-B")!.refundedMinor, 4500);
  });

  test("each order's support request is exactly an allowlisted public demo request", () => {
    for (const o of demoStoreSnapshot(() => NOW).orders) {
      const demo = PUBLIC_DEMOS[o.supportRequest.scenario];
      assert.deepEqual({ customerId: o.customerId, orderId: o.orderId, message: o.supportRequest.message }, demo);
    }
  });
});

describe("demo store over every ingress", () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = createApp(ingressFor(makeDeps()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  test("node server: GET /api/demo-store, POST is 405", async () => {
    const r = await fetch(`${base}/api/demo-store`);
    assert.equal(r.status, 200);
    const s = (await r.json()) as ReturnType<typeof demoStoreSnapshot>;
    assert.equal(s.orders.length, 4);
    assert.equal((await fetch(`${base}/api/demo-store`, { method: "POST" })).status, 405);
  });

  test("vercel and netlify wrappers serve the same snapshot", async () => {
    for (const h of [vercelDemoStore, netlifyDemoStore]) {
      const r = await h(new Request("https://demo.example/api/demo-store"));
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as { orders: unknown[] }).orders.length, 4);
    }
  });

  test("vertical slice: store support requests become real cases (resolve / escalate)", async () => {
    const expected: Record<string, string> = { "48291": "RESOLVED", "48292": "ESCALATED", "48293": "CLOSED_NO_ACTION", "48294": "ESCALATED" };
    const s = (await (await fetch(`${base}/api/demo-store`)).json()) as ReturnType<typeof demoStoreSnapshot>;
    for (const o of s.orders) {
      const res = await fetch(`${base}/cases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: o.customerId, orderId: o.orderId, message: o.supportRequest.message }),
      });
      assert.equal(res.status, 200, o.orderId);
      const c = (await res.json()) as Case;
      assert.equal(c.state, expected[o.orderId], o.orderId);
      if (o.orderId === "48294") assert.equal(c.action, null, "the hostile request moves no money");
    }
  });

  test("snapshot exposes no credentials and no engine internals", () => {
    const text = JSON.stringify(demoStoreSnapshot(() => NOW));
    assert.ok(!/Bearer |API_KEY|JARVIS_/.test(text), "no credentials or env names");
    assert.ok(!/"(idempotencyKey|sections|checks|autoRefundLimitMinor)"/.test(text), "no policy or gateway internals");
  });
});
