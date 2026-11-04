// Starts one disposable browser worker and talks to it over stdin/stdout (newline-delimited JSON).
// Two launchers:
//   "sandbox": docker run under gVisor (runsc), network=none, read-only, non-root, capped, no secrets in env.
//              Its only network path is the per-run gateway socket bind-mounted from the host.
//   "local":   a plain child process on the developer machine, for the LOCAL tiers only. It is NOT isolated and
//              every record it produces says so.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "worker");

export interface SandboxLimits {
  image: string; // pinned, e.g. proofops-worker:1.64.1
  runtime: "runsc" | "runc";
  memoryMb: number;
  cpus: number;
  pids: number;
  chromiumNoSandbox: boolean; // documented tradeoff under gVisor, recorded in evidence
}

export type LaunchSpec =
  | { kind: "local"; runId: string; proxyUrl: string }
  | { kind: "sandbox"; runId: string; socketDir: string; limits: SandboxLimits };

export interface WorkerEvent { at: string; type: string; [k: string]: unknown }

export interface WorkerHandle {
  readonly kind: LaunchSpec["kind"];
  readonly containerName: string | null;
  readonly launchArgs: string[];
  /** OS process id of the launcher (worker process locally, docker client in the sandbox). */
  readonly pid: number | undefined;
  call<T = unknown>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** What Docker itself reports for the running container (sandbox only; null locally). */
  inspect(): Promise<Record<string, unknown> | null>;
  /** Kills the worker and confirms it is gone. Safe to call more than once. */
  destroy(): Promise<{ workerGone: boolean; detail: string }>;
  events: WorkerEvent[];
}

export function sandboxArgs(spec: Extract<LaunchSpec, { kind: "sandbox" }>, name: string): string[] {
  const l = spec.limits;
  return [
    "run", "--rm", "-i", "--name", name,
    "--label", `proofops.run=${spec.runId}`,
    `--runtime=${l.runtime}`,
    "--network=none",
    "--user", "10001:10001",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    `--memory=${l.memoryMb}m`, `--memory-swap=${l.memoryMb}m`,
    `--cpus=${l.cpus}`, `--pids-limit=${l.pids}`, "--shm-size=512m",
    "--env-file", "/dev/null", // nothing inherited
    "-e", `PROOFOPS_RUN_ID=${spec.runId}`,
    "-e", "PROOFOPS_GATEWAY_SOCKET=/run/proofops/gw.sock",
    "-e", `PROOFOPS_CHROMIUM_NO_SANDBOX=${l.chromiumNoSandbox ? "1" : "0"}`,
    "-e", "HOME=/tmp",
    "-v", `${spec.socketDir}:/run/proofops`,
    l.image,
  ];
}

export async function launchWorker(spec: LaunchSpec): Promise<WorkerHandle> {
  let child: ChildProcess;
  let containerName: string | null = null;
  let launchArgs: string[];
  if (spec.kind === "local") {
    launchArgs = [join(WORKER_DIR, "worker.mjs")];
    child = spawn(process.execPath, launchArgs, {
      cwd: WORKER_DIR,
      // Explicit minimal environment: no inherited variables, so no secrets can leak into the worker.
      env: { PROOFOPS_RUN_ID: spec.runId, PROOFOPS_PROXY: spec.proxyUrl, SYSTEMROOT: process.env.SYSTEMROOT ?? "",
             PATH: process.env.PATH ?? "", LOCALAPPDATA: process.env.LOCALAPPDATA ?? "", USERPROFILE: process.env.USERPROFILE ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } else {
    containerName = `proofops-${spec.runId}`;
    launchArgs = sandboxArgs(spec, containerName);
    child = spawn("docker", launchArgs, { env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
  }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const events: WorkerEvent[] = [];
  let nextId = 1;
  let exited = false;
  let stderrTail = "";
  child.stderr!.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2_000); });
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: WorkerEvent };
    try { msg = JSON.parse(line); } catch { events.push({ at: new Date().toISOString(), type: "worker.non_json", line: line.slice(0, 200) }); return; }
    if (msg.event) { events.push(msg.event); return; }
    const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "worker_error"));
  });
  const exitedPromise = new Promise<number | null>((resolve) => child.on("exit", (code) => {
    exited = true;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`worker_exited: ${code} ${stderrTail.slice(-300)}`)); }
    pending.clear();
    resolve(code);
  }));

  const handle: WorkerHandle = {
    kind: spec.kind,
    pid: child.pid,
    containerName,
    launchArgs,
    events,
    call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
      if (exited) return Promise.reject(new Error("worker_exited"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`worker_timeout: ${op}`)); }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        child.stdin!.write(JSON.stringify({ id, op, ...args }) + "\n");
      });
    },
    async inspect() {
      if (spec.kind === "local") return null;
      for (let i = 0; i < 40; i++) {
        try {
          const { stdout } = await run("docker", ["inspect", "--format", "{{json .HostConfig}}", containerName!]);
          const h = JSON.parse(stdout) as Record<string, unknown>;
          return { runtime: h.Runtime, networkMode: h.NetworkMode, readonlyRootfs: h.ReadonlyRootfs, capDrop: h.CapDrop, privileged: h.Privileged,
            memory: h.Memory, nanoCpus: h.NanoCpus, pidsLimit: h.PidsLimit, binds: h.Binds };
        } catch { await new Promise((r) => setTimeout(r, 250)); }
      }
      return null;
    },
    async destroy() {
      if (!exited) {
        try { await handle.call("close", {}, 5_000); } catch { /* fall through to kill */ }
      }
      if (!exited) child.kill("SIGKILL");
      await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, 5_000))]);
      if (spec.kind === "local") return { workerGone: exited, detail: exited ? "local worker process exited" : "local worker did not exit" };
      // Confirm with Docker itself, by label: the container must not exist any more.
      await run("docker", ["rm", "-f", containerName!]).catch(() => {});
      // --rm may already be removing it: `docker rm -f` then returns at once while the container stays listed for a
      // moment. Give Docker a bounded time to finish; if it is still listed after that, teardown is reported as not proven.
      let stdout = "";
      for (let i = 0; i < 20; i++) {
        ({ stdout } = await run("docker", ["ps", "-a", "-q", "--filter", `label=proofops.run=${spec.runId}`]).catch(() => ({ stdout: "error" })));
        if (stdout.trim() === "") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const gone = stdout.trim() === "";
      return { workerGone: gone, detail: gone ? `no container with label proofops.run=${spec.runId}` : `container still listed: ${stdout.trim()}` };
    },
  };
  return handle;
}
