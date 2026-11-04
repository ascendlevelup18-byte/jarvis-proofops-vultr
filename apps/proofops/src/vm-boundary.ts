// VULTR GVISOR tier: boundary probes run inside a real worker container on the VM, launched with exactly the
// production sandbox flags (sandboxArgs) and a real per-run gateway socket. Prints one JSON report and exits
// non-zero if any probe that must fail succeeds, or any probe that must succeed fails. Fails closed: if the
// container cannot start under runsc, that is a failure, never a fallback.
//   sudo -u proofops node apps/proofops/src/vm-boundary.ts [--image proofops-worker:1.64.1]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createStorefront, STORE_HOST } from "./storefront.ts";
import { newSignerKeys } from "./approval.ts";
import { createGateway, type GatewayEvent } from "./gateway.ts";
import { sandboxArgs } from "./worker-client.ts";

const image = process.argv.includes("--image") ? process.argv[process.argv.indexOf("--image") + 1]! : "proofops-worker:1.64.1";
const runId = `run_vmprobe_${Date.now()}`;
const socketDir = join("/run/proofops", runId);

// Runs inside the container with the worker's uid and the sandbox flags. No network interface except lo.
const PROBE = String.raw`
const net = require("node:net"), dns = require("node:dns"), fs = require("node:fs"), http = require("node:http"), dgram = require("node:dgram");
const out = {};
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); r("CONNECTED"); }); s.on("error", (e) => r(e.code || e.message)); s.on("timeout", () => { s.destroy(); r("TIMEOUT"); }); });
const viaGateway = (target, method = "GET") => new Promise((r) => {
  const q = http.request({ socketPath: "/run/proofops/gw.sock", method, path: target, timeout: 5000 }, (res) => { res.resume(); r(res.statusCode); });
  q.on("error", (e) => r(e.code || e.message)); q.on("timeout", () => { q.destroy(); r("TIMEOUT"); }); q.end(); });
(async () => {
  out.uid = process.getuid(); out.gid = process.getgid();
  out.envKeys = Object.keys(process.env).sort();
  out.interfaces = Object.keys(require("node:os").networkInterfaces());
  out.tcp_internet = await tcp("1.1.1.1", 80);
  out.tcp_metadata = await tcp("169.254.169.254", 80);
  out.tcp_ipv6 = await tcp("2606:4700:4700::1111", 80);
  out.tcp_host_ssh = await tcp("172.17.0.1", 22);
  out.dns = await new Promise((r) => dns.lookup("example.com", (e, a) => r(e ? (e.code || e.message) : "RESOLVED " + a)));
  out.udp = await new Promise((r) => { const s = dgram.createSocket("udp4"); s.send(Buffer.from("x"), 53, "1.1.1.1", (e) => { s.close(); r(e ? (e.code || e.message) : "SENT"); }); });
  out.docker_sock = fs.existsSync("/var/run/docker.sock") || fs.existsSync("/run/docker.sock");
  out.host_secrets_visible = ["/etc/proofops/inference.env", "/var/lib/proofops", "/root/.ssh"].filter((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
  out.rootfs_write = (() => { try { fs.writeFileSync("/opt/proofops-worker/x", "x"); return "WRITABLE"; } catch (e) { return e.code; } })();
  out.proc_1 = (() => { try { return fs.readFileSync("/proc/1/cmdline", "utf8").replace(/\0/g, " ").trim(); } catch (e) { return e.code; } })();
  out.kernel = (() => { try { return fs.readFileSync("/proc/version", "utf8").trim(); } catch (e) { return e.code; } })();
  out.gw_store = await viaGateway("http://store.proofops.test" + process.env.PROBE_PATH);
  out.gw_canary = await viaGateway("http://canary.proofops.test/collect");
  out.gw_metadata = await viaGateway("http://169.254.169.254/latest/meta-data/");
  out.gw_loopback = await viaGateway("http://127.0.0.1:22/");
  out.gw_other_run = await viaGateway("http://store.proofops.test/s/000000000000000000000000/");
  out.gw_connect = await viaGateway("store.proofops.test:443", "CONNECT");
  // Guest kernel log: under gVisor the Sentry prints its own boot lines here.
  out.dmesg = (() => { try { return require("node:child_process").execSync("dmesg 2>&1", { encoding: "utf8" }).slice(0, 2000); } catch (e) { return "dmesg unavailable: " + (e.code || e.message); } })();
  // Stay alive briefly so the host can inspect the running container from outside.
  await new Promise((r) => setTimeout(r, 3000));
  process.stdout.write(JSON.stringify(out));
})();`;

const keys = newSignerKeys();
const store = createStorefront({ approvalPublicKey: keys.publicKey });
await new Promise<void>((r) => store.publicServer.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => store.trustedServer.listen(0, "127.0.0.1", r));
const trusted = `http://127.0.0.1:${(store.trustedServer.address() as AddressInfo).port}`;
const { basePath } = (await (await fetch(`${trusted}/sessions`, { method: "POST", body: JSON.stringify({ runId, mode: "normal" }) })).json()) as { basePath: string };
const gwEvents: GatewayEvent[] = [];
const gw = createGateway({ runId, allowedHost: STORE_HOST, allowedPathPrefix: basePath, upstream: { host: "127.0.0.1", port: (store.publicServer.address() as AddressInfo).port }, onEvent: (e) => gwEvents.push(e) });
mkdirSync(socketDir, { recursive: true, mode: 0o711 });
await new Promise<void>((r) => gw.listen(join(socketDir, "gw.sock"), r));
chmodSync(join(socketDir, "gw.sock"), 0o666);

const args = sandboxArgs({ kind: "sandbox", runId, socketDir, limits: { image, runtime: "runsc", memoryMb: 1024, cpus: 1, pids: 256, chromiumNoSandbox: false } }, `proofops-${runId}`);
// Same flags as production; only the entrypoint is replaced by the probe script.
const at = args.indexOf(image);
const probeArgs = [...args.slice(0, at), "-e", `PROBE_PATH=${basePath}`, "--entrypoint", "node", image, "-e", PROBE];
const started = Date.now();
// Run the probe and, while it is alive, ask Docker (outside the sandbox) what it actually started.
const child = spawn("docker", probeArgs, { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const killTimer = setTimeout(() => child.kill("SIGKILL"), 90_000);
let inspected: Record<string, unknown> | null = null;
for (let i = 0; i < 40 && inspected === null; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const raw = execFileSync("docker", ["inspect", "--format", "{{json .HostConfig}}|{{json .Config.User}}|{{json .Config.Env}}", `proofops-${runId}`], { encoding: "utf8" }).trim();
    const [host, user, env] = raw.split("|");
    const h = JSON.parse(host!);
    inspected = { runtime: h.Runtime, networkMode: h.NetworkMode, readonlyRootfs: h.ReadonlyRootfs, capDrop: h.CapDrop, securityOpt: h.SecurityOpt,
      memory: h.Memory, memorySwap: h.MemorySwap, nanoCpus: h.NanoCpus, pidsLimit: h.PidsLimit, binds: h.Binds, privileged: h.Privileged,
      user: JSON.parse(user!), envNames: (JSON.parse(env!) as string[]).map((e) => e.split("=")[0]) };
  } catch { /* not started yet */ }
}
const status = await new Promise<number | null>((r) => child.on("close", (code) => r(code)));
clearTimeout(killTimer);
const res = { stdout, stderr, status };
const inspectRuntime = (() => { try { return execFileSync("docker", ["info", "--format", "{{json .Runtimes}}"], { encoding: "utf8" }).trim(); } catch { return "unavailable"; } })();
const leftover = execFileSync("docker", ["ps", "-a", "-q", "--filter", `label=proofops.run=${runId}`], { encoding: "utf8" }).trim();
gw.close();
await store.close();
rmSync(socketDir, { recursive: true, force: true });

let probe: Record<string, unknown> | null = null;
try { probe = JSON.parse(res.stdout); } catch { /* reported below */ }
const must = (name: string, ok: boolean, detail: unknown) => ({ name, ok, detail });
const NET_FAIL = (v: unknown) => typeof v === "string" && v !== "CONNECTED" && !String(v).startsWith("RESOLVED") && v !== "SENT";
const checks = probe ? [
  must("Docker reports the running container's runtime as runsc (observed from the host)", inspected?.runtime === "runsc", inspected?.runtime ?? "not inspected"),
  must("guest kernel log shows gVisor (observed inside)", /gvisor/i.test(String(probe.dmesg)), String(probe.dmesg).slice(0, 300)),
  must("host-observed isolation: network none, read-only root, all caps dropped, not privileged",
    inspected?.networkMode === "none" && inspected?.readonlyRootfs === true && JSON.stringify(inspected?.capDrop) === JSON.stringify(["ALL"]) && inspected?.privileged === false, inspected),
  must("host-observed limits: 1 GiB memory, no extra swap, 1 CPU, 256 pids",
    inspected?.memory === 1073741824 && inspected?.memorySwap === 1073741824 && inspected?.nanoCpus === 1e9 && inspected?.pidsLimit === 256, inspected),
  must("only the per-run socket directory is mounted", JSON.stringify(inspected?.binds) === JSON.stringify([`${socketDir}:/run/proofops`]), inspected?.binds),
  must("non-root uid 10001", probe.uid === 10001, probe.uid),
  must("only loopback interface", JSON.stringify(probe.interfaces) === JSON.stringify(["lo"]), probe.interfaces),
  must("no secret-named env vars", !(probe.envKeys as string[]).some((k) => /KEY|SECRET|TOKEN|PASSWORD/i.test(k)), probe.envKeys),
  must("raw TCP to internet fails", NET_FAIL(probe.tcp_internet), probe.tcp_internet),
  must("TCP to metadata 169.254.169.254 fails", NET_FAIL(probe.tcp_metadata), probe.tcp_metadata),
  must("IPv6 TCP fails", NET_FAIL(probe.tcp_ipv6), probe.tcp_ipv6),
  must("TCP to host bridge fails", NET_FAIL(probe.tcp_host_ssh), probe.tcp_host_ssh),
  must("DNS resolution fails", NET_FAIL(probe.dns), probe.dns),
  must("UDP send fails", NET_FAIL(probe.udp), probe.udp),
  must("no Docker socket inside", probe.docker_sock === false, probe.docker_sock),
  must("no host secrets or state visible", (probe.host_secrets_visible as string[]).length === 0, probe.host_secrets_visible),
  must("root filesystem read-only", probe.rootfs_write !== "WRITABLE", probe.rootfs_write),
  must("gateway socket reaches the run's store (200)", probe.gw_store === 200, probe.gw_store),
  must("gateway refuses canary host", probe.gw_canary === 403, probe.gw_canary),
  must("gateway refuses metadata", probe.gw_metadata === 403, probe.gw_metadata),
  must("gateway refuses loopback", probe.gw_loopback === 403, probe.gw_loopback),
  must("gateway refuses another run's session", probe.gw_other_run === 403, probe.gw_other_run),
  must("gateway refuses CONNECT", probe.gw_connect === 403 || probe.gw_connect === "ECONNRESET", probe.gw_connect),
  must("container removed after exit", leftover === "", leftover || "none"),
] : [must("probe container ran under runsc", false, { status: res.status, stderr: (res.stderr ?? "").slice(-800), stdoutHead: stdout.slice(0, 600), stdoutLen: stdout.length })];

const report = { tier: "VULTR_GVISOR", runId, image, at: new Date().toISOString(), durationMs: Date.now() - started, dockerRuntimes: inspectRuntime,
  launchFlags: probeArgs.filter((a) => a.startsWith("--") || a === "-v"), hostObserved: inspected, probe, gatewayDecisions: gwEvents, checks,
  passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length };
const outPath = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : null;
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.failed === 0 ? 0 : 1);
