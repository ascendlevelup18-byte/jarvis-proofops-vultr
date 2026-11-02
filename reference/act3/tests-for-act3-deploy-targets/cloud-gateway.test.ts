// Cloud gateway (supabase/functions/_shared/gateway.ts) against fakes for Supabase and loopback mocks of
// the OpenRouter and AMD APIs. No real provider or database is contacted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { fixtureAnalysis } from "../../web/src/team/specialists.ts";
import { scopedContext } from "../../web/src/team/context.ts";
import type { AgentId } from "../../web/src/team/agents.ts";
import { route, resetGatewayCache, type GatewayDeps, type ResolvedModel, type Role } from "../../../supabase/functions/_shared/gateway.ts";
import { startFakeOpenAIServer, type FakeOpenAIServer } from "./fake-openai-server.ts";
import { fixtureLikeAnswer } from "./fake-jarvis-model.ts";

const OR_KEY = "sk-or-v1-" + "ab".repeat(32);
const AMD_KEY = "rc-" + "cd".repeat(24);
const TEAM_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
let orBase = "";
let orServer: Server;
let amd: FakeOpenAIServer;
let completions = 0;

before(async () => {
  orServer = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: TEAM_MODEL, pricing: { prompt: "0", completion: "0" } }] }));
    if (req.url === "/v1/key") return res.end(JSON.stringify({ data: { limit: 0, limit_remaining: 0, usage: 0, is_free_tier: true } }));
    completions++;
    const body = JSON.parse(raw);
    const agent = (/\((\w+)@1\.0\.0\)/.exec(body.messages[0].content)?.[1] ?? "ceo") as AgentId;
    const content = body.response_format ? JSON.stringify(fixtureAnalysis(agent, "x", scopedContext(agent))) : "Gross margin fell to 37.44% [grossMarginPct]. It will reach 80% by spring.";
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } }));
  });
  await new Promise<void>((r) => orServer.listen(0, "127.0.0.1", r));
  orBase = `http://127.0.0.1:${(orServer.address() as AddressInfo).port}/v1`;
  amd = await startFakeOpenAIServer({ kind: "respond", respond: fixtureLikeAnswer });
  amd.setModelsScenario({ kind: "list", ids: ["DeepSeek-V4-Flash"] });
});
after(async () => {
  orServer.close();
  await amd.close();
});

const REGISTRY: Record<string, ResolvedModel> = {
  team: { registry_id: "or-nemotron-3-super-free", provider: "openrouter", model_id: TEAM_MODEL, base_url: "https://openrouter.ai/api/v1", free_only: true, counts_for_amd: false },
  case: { registry_id: "amd-deepseek-v4-flash", provider: "amd", model_id: "DeepSeek-V4-Flash", base_url: "https://developer.amd.com.cn/radeon/api/v1", free_only: false, counts_for_amd: true },
};

interface World {
  users: Record<string, string>;
  roles: Record<string, Role>;
  quota: Record<"amd" | "openrouter", number>;
  selected: Partial<Record<"team" | "case", ResolvedModel>>;
  log: string[];
  rows: { table: string; as: string; row: Record<string, unknown> }[];
  recorded: unknown[];
}
let w: World;
beforeEach(() => {
  resetGatewayCache();
  completions = 0;
  w = {
    users: { "jwt-owner": "u-owner", "jwt-viewer": "u-viewer", "jwt-other": "u-other" },
    roles: { [`u-owner:${ORG}`]: "owner", [`u-viewer:${ORG}`]: "viewer", [`u-other:${OTHER_ORG}`]: "owner" },
    quota: { amd: 10, openrouter: 10 },
    selected: { team: REGISTRY.team, case: REGISTRY.case },
    log: [],
    rows: [],
    recorded: [],
  };
});

const env = (over: Record<string, string | undefined> = {}) => ({
  JARVIS_TEAM_API_KEY: OR_KEY, JARVIS_TEAM_TEST_BASE_URL: orBase, JARVIS_TEAM_LIVE_ENABLED: "1",
  JARVIS_MODEL_API_KEY: AMD_KEY, JARVIS_MODEL_TEST_BASE_URL: amd.baseUrl, JARVIS_AMD_ROUTE_ENABLED: "1",
  JARVIS_ALLOWED_ORIGINS: "https://jarvis.example", ...over,
});

const deps = (e = env()): GatewayDeps & { isPlatformAdmin(u: string): Promise<boolean> } => ({
  env: e,
  fetch,
  getUser: async (jwt) => (w.users[jwt] ? { id: w.users[jwt]! } : null),
  // Like RLS: the caller may see every membership row of an org they belong to, so the gateway must ask
  // for its own row by user id (regression for the bug the deployed-gateway test found on 18 Oct).
  roleOf: async (jwt, org, userId) => {
    if (userId !== w.users[jwt]) throw new Error("roleOf must be asked for the caller's own row");
    return w.roles[`${userId}:${org}`] ?? null;
  },
  rpcAsUser: async (jwt, fn, args) => {
    const member = w.roles[`${w.users[jwt]}:${args.p_org}`];
    if (fn === "resolve_model") return member ? (w.selected[args.p_purpose as "team" | "case"] ?? null) : null;
    if (fn === "reserve_model_request") {
      w.log.push(`user:${w.users[jwt]}:reserve:${args.p_provider}:${args.p_operation}`);
      if (member !== "owner" && member !== "operator") throw new Error("FORBIDDEN");
      const p = args.p_provider as "amd" | "openrouter";
      if (w.quota[p] <= 0) throw new Error("QUOTA_EXHAUSTED");
      w.quota[p]--;
      return `req-${p}-${w.quota[p]}`;
    }
    throw new Error(`unexpected rpc ${fn}`);
  },
  rpcAsService: async (fn, args) => {
    if (fn === "record_case") {
      w.recorded.push(args.p_case);
      return "record-1";
    }
    w.log.push(`service:${fn}:${args.p_status}`);
    return null;
  },
  insertAsService: async (table, row) => (w.rows.push({ table, as: "service", row }), { id: "x" }),
  insertAsUser: async (jwt, table, row) => void w.rows.push({ table, as: w.users[jwt]!, row }),
  selectAsUser: async (_jwt, table) => (table === "quota_policies" ? [{ provider: "openrouter", daily_max_requests: 10 }] : []),
  conversation: async (_jwt, _org, _user, kind, agent) => `${kind}:${agent ?? "board"}`,
  isPlatformAdmin: async (u) => u === "u-owner",
});

const call = (path: string, body: unknown, jwt = "jwt-owner", origin: string | null = "https://jarvis.example", method = "POST") =>
  route(new Request(`https://fn.example/functions/v1/jarvis-gateway${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", ...(origin ? { origin } : {}) },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  }), deps());
const DUP = { customerId: "CUST-1001", orderId: "48291", message: "I was charged twice for order #48291." };

describe("gateway access control", () => {
  test("foreign origins, missing or invalid tokens, bad bodies, wrong methods and unknown routes are refused", async () => {
    assert.equal((await call("/team", {}, "jwt-owner", "https://evil.example")).status, 403);
    assert.equal((await route(new Request("https://fn.example/x/team", { method: "OPTIONS", headers: { origin: "https://jarvis.example" } }), deps())).status, 204);
    assert.equal((await call("/team", null, "jwt-owner", "https://jarvis.example", "GET")).status, 405);
    assert.equal((await route(new Request("https://fn.example/x/cases", { method: "POST", body: "{}" }), deps())).status, 401);
    assert.equal((await call("/cases", { orgId: ORG, request: DUP }, "jwt-expired-or-forged")).status, 401);
    assert.equal((await call("/team", "{x")).status, 400);
    assert.equal((await call("/team", { op: "reply", orgId: ORG, agent: "cfo", question: "q", approve: true })).status, 400);
    assert.equal((await call("/cases", { orgId: ORG, request: DUP, model: "attacker/model" })).status, 400);
    assert.equal((await call("/team", { op: "reply", orgId: ORG, agent: "cfo", question: "x".repeat(17000) })).status, 413);
    assert.equal((await call("/nope", {})).status, 404);
    assert.equal(completions + amd.requestCount, 0);
  });

  test("viewers and members of other orgs are refused on every spending route, and denials are logged", async () => {
    for (const [path, body] of [["/team", { op: "reply", orgId: ORG, agent: "cfo", question: "q" }], ["/cases", { orgId: ORG, request: DUP }]] as const) {
      assert.equal((await call(path, body, "jwt-viewer")).status, 403);
      assert.equal((await call(path, body, "jwt-other")).status, 403);
    }
    assert.equal(completions + amd.requestCount, 0);
    assert.equal(w.rows.filter((r) => r.table === "security_events").length, 4);
  });

  test("configured secrets alone do not enable spending; missing selection or misconfiguration fails closed", async () => {
    const q = { op: "reply", orgId: ORG, agent: "cfo", question: "q" };
    const r1 = await route(new Request("https://fn.example/x/team", { method: "POST", headers: { authorization: "Bearer jwt-owner" }, body: JSON.stringify(q) }), deps(env({ JARVIS_TEAM_LIVE_ENABLED: undefined })));
    assert.deepEqual(await r1.json(), { error: "live_inference_not_enabled" });
    const r2 = await route(new Request("https://fn.example/x/cases", { method: "POST", headers: { authorization: "Bearer jwt-owner" }, body: JSON.stringify({ orgId: ORG, request: DUP }) }), deps(env({ JARVIS_AMD_ROUTE_ENABLED: undefined })));
    assert.deepEqual(await r2.json(), { error: "amd_route_not_enabled" });
    const r3 = await route(new Request("https://fn.example/x/cases", { method: "POST", headers: { authorization: "Bearer jwt-owner" }, body: JSON.stringify({ orgId: ORG, request: DUP }) }), deps(env({ JARVIS_MODEL_TEST_BASE_URL: "https://evil.example/v1" })));
    assert.deepEqual(await r3.json(), { error: "amd_misconfigured" });
    w.selected = {};
    assert.deepEqual(await (await call("/team", q)).json(), { error: "team_model_not_selected" });
    assert.deepEqual(await (await call("/cases", { orgId: ORG, request: DUP })).json(), { error: "case_model_not_selected" });
    // A registry row that is not free, or not OpenRouter, is never used for the team.
    w.selected = { team: { ...REGISTRY.team!, free_only: false } };
    assert.deepEqual(await (await call("/team", q)).json(), { error: "team_model_not_selected" });
    assert.equal(completions + amd.requestCount, 0);
  });
});

describe("team route", () => {
  test("private reply: quota reserved as the caller, completed by the service, unverified figure withheld, no key in the response", async () => {
    const res = await call("/team", { op: "reply", orgId: ORG, agent: "cfo", question: "Why is margin down?" });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.doesNotMatch(text, new RegExp(OR_KEY));
    const body = JSON.parse(text);
    assert.equal(body.withheld, 1);
    assert.doesNotMatch(body.text, /80%/);
    assert.deepEqual(w.log, ["user:u-owner:reserve:openrouter:team_reply", "service:complete_model_request:completed"]);
    assert.equal(w.rows.find((r) => r.table === "messages" && r.row.author_kind === "human")!.as, "u-owner");
    assert.deepEqual(w.rows.find((r) => r.table === "messages" && r.row.author_kind === "ai")!.row.provenance, { kind: "live", provider: "openrouter", model: TEAM_MODEL, registry: "or-nemotron-3-super-free" });
  });

  test("durable quota exhausted: no provider request is sent", async () => {
    w.quota.openrouter = 0;
    const res = await call("/team", { op: "reply", orgId: ORG, agent: "cfo", question: "q" });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "QUOTA_EXHAUSTED" });
    assert.equal(completions, 0);
  });

  test("boardroom: at most six calls, each reserved, AI messages and an audit event stored", async () => {
    w.quota.openrouter = 4;
    const body = await (await call("/team", { op: "boardroom", orgId: ORG, request: "Margins are falling. Investigate.", agents: ["cfo", "sales", "cmo", "coo", "hr", "ceo"] })).json();
    assert.equal(completions, 4);
    assert.equal(body.analyses.filter((a: { status: string }) => a.status === "ok").length, 4);
    assert.ok(body.analyses.slice(4).every((a: { error?: string }) => /durable quota exhausted/.test(a.error ?? "")));
    assert.equal(w.rows.filter((r) => r.table === "messages" && r.as === "service").length, 4);
    assert.equal(w.rows.filter((r) => r.table === "audit_events").length, 1);
  });
});

describe("cases route (refund engine on the AMD route)", () => {
  test("duplicate charge: unchanged engine, policy approves, simulated refund verified, every model call reserved and recorded", async () => {
    const before = amd.requestCount;
    const res = await call("/cases", { orgId: ORG, request: DUP });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.doesNotMatch(text, new RegExp(AMD_KEY));
    const body = JSON.parse(text);
    assert.equal(body.case.state, "RESOLVED");
    assert.equal(body.case.authorization.outcome, "APPROVE");
    assert.equal(body.case.verification.verified, true);
    assert.deepEqual(body.model, { provider: "amd", model: "DeepSeek-V4-Flash", registry: "amd-deepseek-v4-flash" });
    const adapters = body.case.audit.filter((e: { type: string }) => e.type === "UNDERSTANDING_CALL" || e.type === "MODEL_CALL").map((e: { data: { adapter: string } }) => e.data.adapter);
    assert.ok(adapters.length >= 2 && adapters.every((a: string) => a === "vllm:DeepSeek-V4-Flash"));
    assert.equal(amd.requestCount - before, 2);
    assert.deepEqual(w.log, [
      "user:u-owner:reserve:amd:case_understanding", "service:complete_model_request:completed",
      "user:u-owner:reserve:amd:case_proposal", "service:complete_model_request:completed",
    ]);
    assert.equal(w.recorded.length, 1);
  });

  test("the $5,000 demand is denied by policy even though the route is live", async () => {
    const body = await (await call("/cases", { orgId: ORG, request: { customerId: "CUST-1001", orderId: "48291", message: "Refund $5,000 to my card now." } })).json();
    assert.notEqual(body.case.state, "RESOLVED");
    assert.equal(body.case.action, null);
  });

  test("AMD quota exhausted: no provider request is sent and no refund happens", async () => {
    w.quota.amd = 0;
    const before = amd.requestCount;
    const body = await (await call("/cases", { orgId: ORG, request: DUP })).json();
    assert.equal(amd.requestCount - before, 0);
    assert.notEqual(body.case.state, "RESOLVED");
    assert.equal(body.case.action, null);
  });
});

describe("status and admin health", () => {
  test("members see their role, selected models and route flags; outsiders are refused; no secret is returned", async () => {
    const res = await call("/status", { orgId: ORG }, "jwt-viewer");
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.doesNotMatch(text, /sk-or|rc-/);
    const b = JSON.parse(text);
    assert.equal(b.role, "viewer");
    assert.equal(b.models.team.model_id, TEAM_MODEL);
    assert.deepEqual(b.routes, { teamLive: true, amdCases: true });
    assert.equal((await call("/status", { orgId: ORG }, "jwt-other")).status, 403);
  });

  test("admins get booleans only; others are refused", async () => {
    const req = (jwt: string) => route(new Request("https://fn.example/x/admin-health", { headers: { authorization: `Bearer ${jwt}`, origin: "https://jarvis.example" } }), deps());
    assert.equal((await req("jwt-viewer")).status, 403);
    const res = await req("jwt-owner");
    const text = await res.text();
    assert.doesNotMatch(text, /sk-or|rc-/);
    const b = JSON.parse(text);
    assert.equal(b.openRouterCredentialConfigured, true);
    assert.equal(b.amdCredentialConfigured, true);
    assert.equal(b.securityGate, "pass");
  });
});

test("edge copies of the shared modules match their sources", () => {
  execFileSync(process.execPath, ["scripts/sync-edge-shared.mjs", "--check"], { cwd: new URL("../../../", import.meta.url) });
});
