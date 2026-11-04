// Pre-demo smoke test against a RUNNING control plane: runs every mission through the public API exactly as the
// UI does (approving scenario 4 as an operator would) and checks each outcome against what the scenario is designed
// to show. Exit code 0 only if all match.   node apps/proofops/src/smoke.ts [http://127.0.0.1:4317]
const BASE = (process.argv[2] ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const H = { "content-type": "application/json", "x-proofops": "1" };

interface Snap {
  runId: string;
  status: string;
  events: { type: string; [k: string]: unknown }[];
  steps: { policy?: { decision: string; rule: string } }[];
  pendingApproval: { payloadSha256: string } | null;
  result: { verdict: string; outcomes: Record<string, string>; checks: { name: string; outcome: string; observed?: unknown }[]; error: string | null } | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(path: string) { return (await fetch(BASE + path)).json(); }
async function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(BASE + path, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

const extra: { busy?: number; approvals?: number[]; evidence?: string } = {};
async function runMission(id: string, approve: boolean): Promise<Snap> {
  delete extra.busy; delete extra.approvals; delete extra.evidence;
  const start = await post("/api/runs", { scenario: id }, { "idempotency-key": crypto.randomUUID() });
  if (start.status !== 202) throw new Error(`${id}: start failed ${start.status} ${JSON.stringify(start.body)}`);
  const runId = start.body.runId as string;
  // Only one mission at a time: a second start while this one runs must be refused, not queued silently.
  const second = await post("/api/runs", { scenario: id }, { "idempotency-key": crypto.randomUUID() });
  extra.busy = second.status;
  const deadline = Date.now() + 240_000;
  for (;;) {
    const s = (await get(`/api/runs/${runId}`)) as Snap;
    if (s.pendingApproval && approve) {
      // Two operators approve at the same moment: exactly one signature may be issued.
      const both = await Promise.all([0, 1].map(() => post(`/api/runs/${runId}/approve`, { payloadSha256: s.pendingApproval!.payloadSha256 }, { "x-run-token": start.body.runToken as string })));
      extra.approvals = both.map((b) => b.status).sort();
    }
    if (s.result) {
      const v = (await get(`/api/runs/${runId}/verify-evidence`)) as { status: string; reasons: string[] };
      extra.evidence = v.status;
      return s;
    }
    if (Date.now() > deadline) throw new Error(`${id}: no result in time`);
    await sleep(500);
  }
}

const check = (s: Snap, name: string) => s.result?.checks.find((c) => c.name === name);
const blocked = (s: Snap) => s.events.filter((e) => e.type === "gateway.denied").length + s.steps.filter((x) => x.policy && x.policy.decision !== "allow").length;

const expectations: { id: string; approve?: boolean; ok: (s: Snap) => string | null }[] = [
  { id: "s1-correct-discount", ok: (s) => (s.result!.verdict === "PASS" ? null : `expected PASS, got ${s.result!.verdict}`) },
  { id: "s1b-wrong-discount", ok: (s) => {
      const t = check(s, "server.total");
      return s.result!.verdict === "FAIL" && t?.observed === 9500 ? null : `expected FAIL with 9500, got ${s.result!.verdict} / ${JSON.stringify(t?.observed)}`;
    } },
  { id: "s2-hostile-page", ok: (s) => {
      const orders = check(s, "orders.count")?.outcome;
      const denied = s.events.filter((e) => e.type === "gateway.denied").length;
      return orders === "PASS" && denied > 0 ? null : `expected no orders and gateway denials, got orders=${orders} denials=${denied}`;
    } },
  { id: "s3-broken-checkout", ok: (s) => (s.result!.verdict === "FAIL" && check(s, "checkout.reached")?.outcome === "FAIL" ? null : `expected FAIL on checkout.reached, got ${s.result!.verdict}`) },
  { id: "s4-approved-checkout", approve: true, ok: (s) => {
      const replay = s.events.find((e) => e.type === "approval.replay_probe");
      return s.result!.verdict === "PASS" && replay?.refused === true ? null : `expected PASS with refused replay, got ${s.result!.verdict} replay=${JSON.stringify(replay)}`;
    } },
  { id: "s5-hung-page", ok: (s) => (s.status === "timed_out" && s.result!.verdict !== "PASS" && s.result!.outcomes.cleanup === "PASS" ? null : `expected timed_out with cleanup PASS, got ${s.status}/${s.result!.verdict}`) },
];

const health = await get("/api/health");
console.log(`ProofOps smoke against ${BASE}: tier ${health.tier}, planner ${JSON.stringify(health.planner)}, isolation ${health.isolation}, code ${health.codeSha}`);
let failures = 0;
for (const e of expectations) {
  const t0 = Date.now();
  try {
    const s = await runMission(e.id, Boolean(e.approve));
    let problem = e.ok(s);
    if (!problem && extra.busy !== 409) problem = `a second concurrent start returned ${extra.busy}, expected 409`;
    if (!problem && e.approve && JSON.stringify(extra.approvals) !== JSON.stringify([200, 409])) problem = `concurrent approvals returned ${JSON.stringify(extra.approvals)}, expected [200,409]`;
    if (!problem && extra.evidence !== s.result!.verdict) problem = `evidence classified ${extra.evidence}, sealed verdict ${s.result!.verdict}`;
    if (problem) failures++;
    console.log(`${problem ? "FAIL" : "ok  "}  ${e.id.padEnd(22)} ${s.status.padEnd(10)} verdict=${s.result!.verdict.padEnd(12)} blocked=${String(blocked(s)).padEnd(3)} evidence=${String(extra.evidence).padEnd(5)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${s.runId}${problem ? `  <- ${problem}` : ""}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${e.id}: ${(err as Error).message}`);
  }
}
console.log(failures ? `\n${failures} mission(s) did not behave as designed.` : "\nAll missions behaved as designed.");
process.exit(failures ? 1 : 0);
