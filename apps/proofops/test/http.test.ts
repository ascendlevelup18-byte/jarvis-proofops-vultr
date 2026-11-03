// UNIT/HTTP tier: storefront and gateway over real sockets, no browser and no model.
// Proves the checkout endpoint itself refuses bypasses (direct POSTs that never touch the browser or policy),
// and that the gateway refuses off-scope traffic and never routes by the request's own authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createStorefront, type SessionState } from "../src/storefront.ts";
import { cartPayloadSha256, issueApproval, newSignerKeys } from "../src/approval.ts";
import { createGateway, type GatewayEvent } from "../src/gateway.ts";

async function setup() {
  const keys = newSignerKeys();
  const store = createStorefront({ approvalPublicKey: keys.publicKey });
  await new Promise<void>((r) => store.publicServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => store.trustedServer.listen(0, "127.0.0.1", r));
  const pub = `http://127.0.0.1:${(store.publicServer.address() as AddressInfo).port}`;
  const trusted = `http://127.0.0.1:${(store.trustedServer.address() as AddressInfo).port}`;
  const session = async (runId: string, mode = "normal") =>
    (await (await fetch(`${trusted}/sessions`, { method: "POST", body: JSON.stringify({ runId, mode }) })).json()) as { sid: string; basePath: string };
  const state = async (sid: string) => (await (await fetch(`${trusted}/sessions/${sid}`)).json()) as SessionState;
  const post = (path: string, form: Record<string, string>) =>
    fetch(pub + path, { method: "POST", body: new URLSearchParams(form), redirect: "manual" });
  return { keys, store, pub, session, state, post };
}

test("checkout endpoint refuses direct submissions without, with forged, replayed or stale approvals", async () => {
  const { keys, store, session, state, post } = await setup();
  try {
    const { sid, basePath } = await session("run-A");
    await post(`${basePath}cart/add`, { sku: "DEMO-001", quantity: "1" });
    await post(`${basePath}cart/coupon`, { code: "SAVE10" });
    assert.equal((await state(sid)).totals?.totalCents, 9000);

    assert.equal((await post(`${basePath}checkout/submit`, {})).status, 403); // no approval
    const forged = newSignerKeys();
    const payload = cartPayloadSha256({ sku: "DEMO-001", quantity: 1, coupon: "SAVE10", totalCents: 9000 });
    const bad = issueApproval(forged.privateKey, { operator: "op", workspace: "ws", runId: "run-A", payloadSha256: payload });
    assert.equal((await post(`${basePath}checkout/submit`, { approval: bad })).status, 403); // forged signer
    const otherRun = issueApproval(keys.privateKey, { operator: "op", workspace: "ws", runId: "run-B", payloadSha256: payload });
    assert.equal((await post(`${basePath}checkout/submit`, { approval: otherRun })).status, 403); // other run
    const stale = issueApproval(keys.privateKey, { operator: "op", workspace: "ws", runId: "run-A",
      payloadSha256: cartPayloadSha256({ sku: "DEMO-001", quantity: 1, coupon: null, totalCents: 10000 }) });
    assert.equal((await post(`${basePath}checkout/submit`, { approval: stale })).status, 403); // cart changed after approval

    const good = issueApproval(keys.privateKey, { operator: "op", workspace: "ws", runId: "run-A", payloadSha256: payload });
    assert.equal((await post(`${basePath}checkout/submit`, { approval: good })).status, 200);
    assert.equal((await post(`${basePath}checkout/submit`, { approval: good })).status, 403); // replay
    const s = await state(sid);
    assert.equal(s.orders.length, 1);
    assert.deepEqual(s.rejectedCheckouts.map((r) => r.reason), ["missing", "bad_signature", "wrong_run", "payload_mismatch", "replayed"]);
  } finally {
    await store.close();
  }
});

test("sessions are isolated: one run's cart is invisible to another", async () => {
  const { store, session, state, post } = await setup();
  try {
    const a = await session("run-A");
    const b = await session("run-B");
    await post(`${a.basePath}cart/add`, { sku: "DEMO-001", quantity: "1" });
    assert.ok((await state(a.sid)).cart);
    assert.equal((await state(b.sid)).cart, null);
  } finally {
    await store.close();
  }
});

function viaProxy(proxyPort: number, method: string, target: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: proxyPort, method, path: target, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on("error", reject);
    r.end();
  });
}

test("gateway forwards only the run's session and refuses everything else, logging each decision", async () => {
  const { store, session } = await setup();
  const { basePath } = await session("run-G");
  const events: GatewayEvent[] = [];
  const gw = createGateway({ runId: "run-G", allowedHost: "store.proofops.test", allowedPathPrefix: basePath,
    upstream: { host: "127.0.0.1", port: (store.publicServer.address() as AddressInfo).port }, onEvent: (e) => events.push(e) });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const port = (gw.address() as AddressInfo).port;
  try {
    assert.equal(await viaProxy(port, "GET", `http://store.proofops.test${basePath}`), 200);
    assert.equal(await viaProxy(port, "GET", "http://canary.proofops.test/collect"), 403);
    assert.equal(await viaProxy(port, "GET", "http://169.254.169.254/latest/meta-data/"), 403);
    assert.equal(await viaProxy(port, "GET", "http://127.0.0.1:22/"), 403);
    assert.equal(await viaProxy(port, "GET", `http://store.proofops.test${basePath}`, { upgrade: "websocket", connection: "upgrade" }), 403);
    // Host header spoofing does not change where the gateway forwards: the authority in the target decides
    // allow/deny, and the upstream is fixed.
    assert.equal(await viaProxy(port, "GET", "http://canary.proofops.test/", { host: "store.proofops.test" }), 403);
    const allowed = events.filter((e) => e.decision === "allow");
    assert.equal(allowed.length, 1);
    assert.ok(events.filter((e) => e.decision === "deny").length >= 5);
  } finally {
    await new Promise<void>((r) => gw.close(() => r()));
    await store.close();
  }
});
