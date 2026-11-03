// Checkout approval tokens. Signed with Ed25519 by the approval signer; verified by the storefront's own
// checkout endpoint. A token binds operator, workspace, run, action, exact cart payload and expiry, and its
// nonce can be consumed once.
import { createHash, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";

export interface ApprovalClaims {
  v: 1;
  operator: string;
  workspace: string;
  runId: string;
  action: "checkout.submit";
  payloadSha256: string;
  expiresAt: number; // epoch ms
  nonce: string;
}

export interface CartPayload {
  sku: string;
  quantity: number;
  coupon: string | null;
  totalCents: number;
}

/** Canonical hash of the exact cart being approved. Field order is fixed. */
export function cartPayloadSha256(p: CartPayload): string {
  const canonical = JSON.stringify([p.sku, p.quantity, p.coupon, p.totalCents]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function newSignerKeys(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

export const MAX_APPROVAL_TTL_MS = 120_000;

export function issueApproval(
  privateKey: KeyObject,
  input: Omit<ApprovalClaims, "v" | "nonce" | "expiresAt" | "action">,
  now = Date.now(),
): string {
  const claims: ApprovalClaims = {
    v: 1,
    ...input,
    action: "checkout.submit",
    expiresAt: now + MAX_APPROVAL_TTL_MS,
    nonce: randomBytes(16).toString("hex"),
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = sign(null, Buffer.from(body), privateKey).toString("base64url");
  return `${body}.${sig}`;
}

export type ApprovalCheck =
  | { ok: true; claims: ApprovalClaims }
  | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "wrong_run" | "wrong_action" | "payload_mismatch" | "expired" | "replayed" };

/** Pure verification; the caller owns the consumed-nonce set so replay is checked against real state. */
export function verifyApproval(
  token: string | undefined | null,
  publicKey: KeyObject,
  expect: { runId: string; payloadSha256: string },
  consumedNonces: Set<string>,
  now = Date.now(),
): ApprovalCheck {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  let good = false;
  try {
    good = verify(null, Buffer.from(body), publicKey, Buffer.from(sig, "base64url"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!good) return { ok: false, reason: "bad_signature" };
  let claims: ApprovalClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ApprovalClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (claims.v !== 1 || typeof claims.nonce !== "string") return { ok: false, reason: "malformed" };
  if (claims.action !== "checkout.submit") return { ok: false, reason: "wrong_action" };
  if (claims.runId !== expect.runId) return { ok: false, reason: "wrong_run" };
  if (claims.payloadSha256 !== expect.payloadSha256) return { ok: false, reason: "payload_mismatch" };
  if (!(claims.expiresAt > now) || claims.expiresAt - now > MAX_APPROVAL_TTL_MS) return { ok: false, reason: "expired" };
  if (consumedNonces.has(claims.nonce)) return { ok: false, reason: "replayed" };
  return { ok: true, claims };
}
