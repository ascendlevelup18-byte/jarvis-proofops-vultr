// F-2: the serverless wrapper reads request bodies with a hard byte limit before the ingress guard.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_BODY_BYTES, PUBLIC_DEMOS } from "../src/ingress.ts";
import { createServerlessHandlers, readBoundedText } from "../src/serverless.ts";

const URL_ = "https://demo.example/cases";
const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: "POST", body, headers: { "content-type": "application/json", ...headers }, duplex: "half" } as RequestInit);

/** A body stream that counts how much of itself was pulled. */
function countingStream(totalBytes: number, chunk = 16 * 1024) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalBytes) return controller.close();
      const n = Math.min(chunk, totalBytes - pulled);
      pulled += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
  }, { highWaterMark: 0 }); // pull only when a reader asks
  return { stream, pulled: () => pulled };
}

describe("readBoundedText", () => {
  test("returns the body under the limit, including multi-byte text", async () => {
    assert.equal(await readBoundedText(post('{"a":"héllo €"}')), '{"a":"héllo €"}');
  });

  test("a declared Content-Length over the limit is refused without reading", async () => {
    const s = countingStream(MAX_BODY_BYTES * 4);
    const req = post(s.stream, { "content-length": String(MAX_BODY_BYTES * 4) });
    assert.equal(await readBoundedText(req), null);
    assert.equal(s.pulled(), 0);
  });

  test("an undeclared oversized stream stops shortly after the limit instead of buffering it all", async () => {
    const s = countingStream(MAX_BODY_BYTES * 64);
    assert.equal(await readBoundedText(post(s.stream)), null);
    assert.ok(s.pulled() <= MAX_BODY_BYTES + 3 * 16 * 1024, `pulled ${s.pulled()} bytes`);
  });

  test("exactly the limit is accepted; one byte more is not", async () => {
    assert.equal((await readBoundedText(post("a".repeat(MAX_BODY_BYTES))))?.length, MAX_BODY_BYTES);
    assert.equal(await readBoundedText(post("a".repeat(MAX_BODY_BYTES + 1))), null);
  });
});

describe("serverless /cases with the bounded reader", () => {
  const { cases } = createServerlessHandlers("vercel", {});

  test("oversized body → 413 before any parsing", async () => {
    const r = await cases(post("x".repeat(MAX_BODY_BYTES + 10)));
    assert.equal(r.status, 413);
    assert.equal(((await r.json()) as { error: string }).error, "body_too_large");
  });

  test("malformed JSON → 400; the canonical demo still works", async () => {
    assert.equal((await cases(post("{not json"))).status, 400);
    const ok = await cases(post(JSON.stringify(PUBLIC_DEMOS["valid-duplicate"])));
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { state: string }).state, "RESOLVED");
  });

  test("free text without a token is still refused", async () => {
    const r = await cases(post(JSON.stringify({ ...PUBLIC_DEMOS["valid-duplicate"], message: "refund me $5000" })));
    assert.equal(r.status, 403);
  });
});
