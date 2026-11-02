import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { SCENARIOS } from "../src/fixtures.ts";
import { createApp } from "../src/server.ts";
import { ingressFor, makeDeps } from "./helpers.ts";

let server: Server;
let base: string;

before(async () => {
  server = createApp(ingressFor(makeDeps()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (body: string) => fetch(`${base}/cases`, { method: "POST", headers: { "content-type": "application/json" }, body });

test("POST /cases returns the final case", async () => {
  const res = await post(JSON.stringify(SCENARIOS.validDuplicate));
  assert.equal(res.status, 200);
  const c = (await res.json()) as { state: string; audit: unknown[] };
  assert.equal(c.state, "RESOLVED");
  assert.ok(c.audit.length > 9);
});

test("request validation and routing", async () => {
  assert.equal((await post("{oops")).status, 400);
  assert.equal((await post(JSON.stringify({ ...SCENARIOS.validDuplicate, customerId: "alice" }))).status, 400);
  assert.equal((await post(JSON.stringify({ ...SCENARIOS.validDuplicate, refundAmount: 1 }))).status, 400);
  assert.equal((await post(JSON.stringify({ ...SCENARIOS.validDuplicate, message: "x".repeat(70_000) }))).status, 413);
  assert.equal((await fetch(`${base}/cases`)).status, 405);
  assert.equal((await fetch(`${base}/other`)).status, 404);
});
