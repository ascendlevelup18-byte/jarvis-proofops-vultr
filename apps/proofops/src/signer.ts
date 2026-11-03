// Approval signer: a separate process that holds the only Ed25519 private key for checkout approvals.
// The control plane can ask it to sign, but only after an operator approves in the UI; it cannot read the key.
// Protocol (stdin/stdout JSON lines):
//   startup -> {"publicKeyPem": "..."}
//   {"id":1,"operator":"...","workspace":"...","runId":"...","payloadSha256":"..."} -> {"id":1,"token":"..."}
// When run as a module (`node signer.ts`), it serves that protocol. `startSigner()` spawns it from the control plane.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createPublicKey, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { issueApproval, newSignerKeys } from "./approval.ts";

export interface SignerHandle {
  publicKey: KeyObject;
  sign(req: { operator: string; workspace: string; runId: string; payloadSha256: string }): Promise<string>;
  stop(): void;
  pid: number | undefined;
}

export async function startSigner(): Promise<SignerHandle> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! });
  const pending = new Map<number, (r: { token?: string; error?: string }) => void>();
  let nextId = 1;
  const publicKeyPem = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("signer did not start")), 10_000);
    lines.once("line", (l) => { clearTimeout(t); resolve((JSON.parse(l) as { publicKeyPem: string }).publicKeyPem); });
  });
  lines.on("line", (l) => {
    const m = JSON.parse(l) as { id: number; token?: string; error?: string };
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  return {
    publicKey: createPublicKey(publicKeyPem),
    pid: child.pid,
    sign(req) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, (r) => (r.token ? resolve(r.token) : reject(new Error(r.error ?? "sign failed"))));
        child.stdin!.write(JSON.stringify({ id, ...req }) + "\n");
      });
    },
    stop: () => child.kill(),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { privateKey, publicKey } = newSignerKeys();
  process.stdout.write(JSON.stringify({ publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }) + "\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    let m: { id?: number; operator?: string; workspace?: string; runId?: string; payloadSha256?: string };
    try { m = JSON.parse(line); } catch { return; }
    const ok = typeof m.id === "number" && [m.operator, m.workspace, m.runId].every((v) => typeof v === "string" && v.length > 0 && v.length <= 80)
      && typeof m.payloadSha256 === "string" && /^[0-9a-f]{64}$/.test(m.payloadSha256);
    if (!ok) return process.stdout.write(JSON.stringify({ id: m.id ?? null, error: "bad_request" }) + "\n");
    const token = issueApproval(privateKey, { operator: m.operator!, workspace: m.workspace!, runId: m.runId!, payloadSha256: m.payloadSha256! });
    process.stdout.write(JSON.stringify({ id: m.id, token }) + "\n");
  });
}
