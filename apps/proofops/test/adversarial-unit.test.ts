// Round-2 adversarial regressions, [UNIT] and [HTTP] tiers: proxy forms, approval token abuse, false success,
// tool-argument manipulation and money precision.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { decide } from "../src/gateway.ts";
import { checkAction, type Observation, type RunScope } from "../src/policy.ts";
import { cartPayloadSha256, issueApproval, newSignerKeys, verifyApproval } from "../src/approval.ts";
import { freezeSpec, parseUsdCents } from "../src/fixtures.ts";
import { verify, type VerifierInput } from "../src/verifier.ts";
import { createStorefront, type SessionState } from "../src/storefront.ts";

const P = "/s/aaaaaaaaaaaaaaaaaaaaaaaa/";
const o = { allowedHost: "store.proofops.test", allowedPathPrefix: P };
const gw = (m: string, t: string, h = {}) => { const v = decide(m, t, h, o); return v.ok ? "allow" : v.reason; };

test("R2-A [UNIT] gateway: CONNECT over IPv6, scheme-relative, backslash and dot-segment forms are refused", () => {
  assert.equal(gw("CONNECT", "[::1]:443"), "connect_refused");
  assert.equal(gw("CONNECT", "[2606:4700::1111]:443"), "connect_refused");
  assert.equal(gw("GET", `//store.proofops.test${P}`), "not_absolute_form");
  assert.notEqual(gw("GET", `http://store.proofops.test${P}..\\..\\x`), "allow");
  assert.notEqual(gw("GET", `http://store.proofops.test/s/aaaaaaaaaaaaaaaaaaaaaaaa/../bbbbbbbbbbbbbbbbbbbbbbbb/`), "allow");
  assert.notEqual(gw("GET", `http://store.proofops.test/s/aaaaaaaaaaaaaaaaaaaaaaaa%2f..%2fbbbbbbbbbbbbbbbbbbbbbbbb/`), "allow");
  assert.notEqual(gw("GET", `http://store.proofops.test${P}`, { upgrade: "h2c" }), "allow");
  assert.equal(gw("GET", `http://store.proofops.test${P}cart?x=1#frag`), "allow");
});

const scope: RunScope = { base: `http://store.proofops.test${P}`, navigablePaths: ["/", "/cart", "/checkout"], fillableInputs: ["code"], consequentialPaths: ["/checkout/submit"], maxSteps: 12 };
const obs: Observation = { epoch: 2, url: scope.base, title: "", text: "", elements: [
  { ref: "e1", tag: "a", text: "file link", href: "file:///etc/passwd" },
  { ref: "e2", tag: "a", text: "js link", href: "javascript:alert(1)" },
  { ref: "e3", tag: "input", type: "text", name: "code", text: "Promo code" },
  { ref: "e4", tag: "a", text: "data link", href: "data:text/html,<script>alert(1)</script>" },
] };

test("R2-D [UNIT] file:, javascript: and data: targets are refused, in links and in navigate paths", () => {
  const d = (a: unknown) => { const r = checkAction(a, obs, scope, 0); return r.decision === "allow" ? "allow" : r.rule; };
  assert.equal(d({ tool: "click", ref: "e1", epoch: 2 }), "click_link_out_of_scope");
  assert.equal(d({ tool: "click", ref: "e2", epoch: 2 }), "click_link_out_of_scope");
  assert.equal(d({ tool: "click", ref: "e4", epoch: 2 }), "click_link_out_of_scope");
  for (const p of ["file:///etc/passwd", "/\\\\host/share", "/%2e%2e/x", "/cart/../../x", " /cart", "/cart\n"]) {
    assert.notEqual(d({ tool: "navigate", path: p }), "allow", p);
  }
});

test("R2-D [UNIT] tool-argument manipulation: extra fields, wrong types, oversized and control-character values", () => {
  const d = (a: unknown) => { const r = checkAction(a, obs, scope, 0); return r.decision === "allow" ? "allow" : r.rule; };
  assert.equal(d({ tool: "fill", ref: "e3", epoch: 2, value: "SAVE10", selector: "#coupon" }), "schema");
  assert.equal(d({ tool: "fill", ref: "e3", epoch: "2", value: "SAVE10" }), "schema");
  assert.equal(d({ tool: "fill", ref: "e3", epoch: 2, value: "A".repeat(65) }), "schema");
  assert.equal(d({ tool: "fill", ref: "e3", epoch: 2, value: "SAVE10\u0000" }), "fill_value_charset");
  assert.equal(d({ tool: "fill", ref: "e3", epoch: 2, value: "SAVE10‮" }), "fill_value_charset");
  assert.equal(d({ tool: "click", ref: "#add-to-cart", epoch: 2 }), "schema");
  assert.equal(d([{ tool: "finish" }]), "schema");
  assert.equal(d(null), "schema");
});

test("R2-B [UNIT] malformed approval tokens are rejected without throwing", () => {
  const { publicKey } = newSignerKeys();
  const used = new Set<string>();
  const exp = { runId: "r", payloadSha256: "0".repeat(64) };
  for (const t of ["", ".", "a.b", "a.b.c", "x".repeat(5000), "e30.", ".sig", "%%%.%%%", "eyJ2IjoxfQ.AAAA"]) {
    const r = verifyApproval(t, publicKey, exp, used);
    assert.equal(r.ok, false, t.slice(0, 20));
  }
});

test("R2-B [UNIT] a token signed for one step's cart cannot be reused at a later step with a different cart", () => {
  const { privateKey, publicKey } = newSignerKeys();
  const first = cartPayloadSha256({ sku: "DEMO-001", quantity: 1, coupon: "SAVE10", totalCents: 9000 });
  const later = cartPayloadSha256({ sku: "DEMO-001", quantity: 2, coupon: "SAVE10", totalCents: 19000 });
  const tok = issueApproval(privateKey, { operator: "op", workspace: "ws", runId: "r", payloadSha256: first });
  assert.deepEqual(verifyApproval(tok, publicKey, { runId: "r", payloadSha256: later }, new Set()), { ok: false, reason: "payload_mismatch" });
});

test("R2-B [UNIT] tokens claiming a far-future expiry are refused (TTL is capped)", () => {
  const { privateKey, publicKey } = newSignerKeys();
  const payload = "1".repeat(64);
  const now = 1_800_000_000_000;
  const tok = issueApproval(privateKey, { operator: "op", workspace: "ws", runId: "r", payloadSha256: payload }, now + 10 * 60_000); // issued "in the future"
  assert.deepEqual(verifyApproval(tok, publicKey, { runId: "r", payloadSha256: payload }, new Set(), now), { ok: false, reason: "expired" });
});

test("R2-C [UNIT] money parsing refuses ambiguous or imprecise amounts", () => {
  assert.equal(parseUsdCents("$90.00"), 9000);
  assert.equal(parseUsdCents("$90.0"), null);
  assert.equal(parseUsdCents("$90"), null);
  assert.equal(parseUsdCents("90.00"), null);
  assert.equal(parseUsdCents("$90.001"), null);
  assert.equal(parseUsdCents("$9,000.00"), 900000);
  assert.equal(parseUsdCents("€90.00"), null);
  assert.equal(parseUsdCents("$90.00 $90.00"), null);
});

const good = (): VerifierInput => ({
  runId: "run-x",
  spec: freezeSpec("normal"),
  dom: { subtotal: "$100.00", discount: "-$10.00", total: "$90.00", checkoutMarker: true },
  server: { sid: "s", runId: "run-x", mode: "normal", cart: { sku: "DEMO-001", quantity: 1 }, coupon: "SAVE10",
            totals: { subtotalCents: 10000, discountCents: 1000, totalCents: 9000 }, checkoutReached: true, orders: [], rejectedCheckouts: [] },
  policy: { dispatched: 4, dispatchedWithoutAllow: 0, denied: 0, needsApproval: 0 },
  network: { measured: true, deniedRequests: 0, allowedOffScope: 0 },
  evidence: { screenshots: 3, hashesMatch: true },
  cleanup: { workerGone: true, detail: "exited" },
});

test("R2-C [UNIT] split-brain both ways is a FAIL: DOM $90 / server $95, and DOM $95 / server $90", () => {
  const a = good(); a.server!.totals = { subtotalCents: 10000, discountCents: 500, totalCents: 9500 };
  assert.equal(verify(a).outcomes.commerce, "FAIL");
  const b = good(); b.dom = { ...b.dom!, discount: "-$5.00", total: "$95.00" };
  assert.equal(verify(b).outcomes.commerce, "FAIL");
});

test("R2-C [UNIT] server state from a different run is never accepted", () => {
  const i = good(); i.server = { ...i.server!, runId: "run-other" };
  const r = verify(i);
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.checks.find((c) => c.name === "server.session_bound")?.outcome, "FAIL");
});

test("R2-C [UNIT] missing cart fields and a missing cart are never PASS", () => {
  const a = good(); a.server = { ...a.server!, totals: null };
  assert.notEqual(verify(a).verdict, "PASS");
  const b = good(); b.server = { ...b.server!, cart: null };
  assert.equal(verify(b).outcomes.commerce, "FAIL");
  const c = good(); c.dom = { subtotal: null, discount: null, total: null, checkoutMarker: true };
  assert.notEqual(verify(c).verdict, "PASS");
});

test("R2-B [HTTP] checkout with a token for another run, an expired-looking token, or as a GET is refused", async () => {
  const keys = newSignerKeys();
  const store = createStorefront({ approvalPublicKey: keys.publicKey });
  await new Promise<void>((r) => store.publicServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => store.trustedServer.listen(0, "127.0.0.1", r));
  const pub = `http://127.0.0.1:${(store.publicServer.address() as AddressInfo).port}`;
  const trusted = `http://127.0.0.1:${(store.trustedServer.address() as AddressInfo).port}`;
  try {
    const a = (await (await fetch(`${trusted}/sessions`, { method: "POST", body: JSON.stringify({ runId: "run-A", mode: "normal" }) })).json()) as { sid: string; basePath: string };
    const post = (p: string, f: Record<string, string>) => fetch(pub + p, { method: "POST", body: new URLSearchParams(f), redirect: "manual" });
    await post(`${a.basePath}cart/add`, { sku: "DEMO-001", quantity: "1" });
    const payload = cartPayloadSha256({ sku: "DEMO-001", quantity: 1, coupon: null, totalCents: 10000 });
    const forB = issueApproval(keys.privateKey, { operator: "op", workspace: "ws", runId: "run-B", payloadSha256: payload });
    assert.equal((await post(`${a.basePath}checkout/submit`, { approval: forB })).status, 403);
    const old = issueApproval(keys.privateKey, { operator: "op", workspace: "ws", runId: "run-A", payloadSha256: payload }, Date.now() - 10 * 60_000);
    assert.equal((await post(`${a.basePath}checkout/submit`, { approval: old })).status, 403);
    const good = issueApproval(keys.privateKey, { operator: "op", workspace: "ws", runId: "run-A", payloadSha256: payload });
    assert.equal((await fetch(`${pub}${a.basePath}checkout/submit?approval=${encodeURIComponent(good)}`)).status, 404, "GET cannot submit");
    const st = (await (await fetch(`${trusted}/sessions/${a.sid}`)).json()) as SessionState;
    assert.equal(st.orders.length, 0);
    assert.deepEqual(st.rejectedCheckouts.map((x) => x.reason), ["wrong_run", "expired"]);
  } finally {
    await store.close();
  }
});
