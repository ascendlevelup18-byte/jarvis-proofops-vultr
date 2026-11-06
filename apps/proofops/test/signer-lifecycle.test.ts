import test from "node:test";
import assert from "node:assert/strict";
import { startSigner } from "../src/signer.ts";

const request = { operator: "test", workspace: "test", runId: "run-test", payloadSha256: "a".repeat(64) };

test("signer refuses calls after stop without hanging or writing to a closed pipe", { timeout: 2000 }, async () => {
  const signer = await startSigner();
  signer.stop();
  await assert.rejects(signer.sign(request), /stopped|closed|exited/);
  signer.stop();
});

test("signer process exit rejects later signing requests", { timeout: 3000 }, async () => {
  const signer = await startSigner();
  try {
    process.kill(signer.pid!);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(signer.sign(request), /closed|exited/);
  } finally { signer.stop(); }
});

test("signer returns a token for a valid request and refuses an invalid request", { timeout: 3000 }, async () => {
  const signer = await startSigner();
  try {
    assert.equal(typeof await signer.sign(request), "string");
    await assert.rejects(signer.sign({ ...request, payloadSha256: "invalid" }), /bad_request/);
  } finally { signer.stop(); }
});

test("a request in flight when the signer dies settles instead of hanging, and no later request is signed", { timeout: 3000 }, async () => {
  const signer = await startSigner();
  try {
    const inFlight = signer.sign(request).then(() => "signed", () => "rejected");
    process.kill(signer.pid!);
    assert.ok(["signed", "rejected"].includes(await inFlight));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(signer.sign(request), /closed|exited/);
  } finally { signer.stop(); }
});

test("two signers never share a key: a token verifies only against its own signer's public key", { timeout: 3000 }, async () => {
  const { verifyApproval } = await import("../src/approval.ts");
  const one = await startSigner();
  const two = await startSigner();
  try {
    const token = await one.sign(request);
    assert.equal(verifyApproval(token, one.publicKey, { runId: "run-test", payloadSha256: request.payloadSha256 }, new Set()).ok, true);
    assert.deepEqual(verifyApproval(token, two.publicKey, { runId: "run-test", payloadSha256: request.payloadSha256 }, new Set()), { ok: false, reason: "bad_signature" });
  } finally { one.stop(); two.stop(); }
});
