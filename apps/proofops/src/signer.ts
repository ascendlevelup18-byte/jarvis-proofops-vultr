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
  const pending = new Map<number, { resolve: (token: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let closed: Error | null = null;
  let startupReject: ((e: Error) => void) | undefined;
  const fail = (error: Error) => {
    if (closed) return;
    closed = error;
    startupReject?.(error);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
    child.kill();
  };
  child.on("error", (e) => fail(e));
  child.on("exit", () => fail(new Error("signer exited")));
  child.stdin!.on("error", () => fail(new Error("signer pipe closed")));
  lines.on("close", () => fail(new Error("signer output closed")));
  const publicKeyPem = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => fail(new Error("signer did not start")), 10_000);
    startupReject = (e) => { clearTimeout(t); reject(e); };
    lines.once("line", (l) => {
      try {
        const m = JSON.parse(l);
        if (typeof m.publicKeyPem !== "string") throw new Error("invalid signer startup reply");
        createPublicKey(m.publicKeyPem);
        clearTimeout(t); startupReject = undefined; resolve(m.publicKeyPem);
      } catch { fail(new Error("invalid signer startup reply")); }
    });
  });
  lines.on("line", (l) => {
    try {
      const m = JSON.parse(l) as { id: number; token?: string; error?: string };
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer); pending.delete(m.id);
      if (typeof m.token === "string") p.resolve(m.token);
      else p.reject(new Error(m.error ?? "sign failed"));
    } catch { fail(new Error("invalid signer reply")); }
  });
  return {
    publicKey: createPublicKey(publicKeyPem),
    pid: child.pid,
    sign(req) {
      if (closed) return Promise.reject(closed);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error("signer request timed out")), 10_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin!.write(JSON.stringify({ id, ...req }) + "\n", (e) => { if (e) fail(e); });
      });
    },
    stop: () => fail(new Error("signer stopped")),
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
