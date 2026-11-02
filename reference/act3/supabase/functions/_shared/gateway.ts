// JARVIS cloud gateway, runtime-neutral (Deno Edge Functions in production, Node in tests).
//
// Routes (all POST except admin-health; all need a Supabase user JWT):
//   /team          AI Executive Team on the org's selected OpenRouter free model
//   /cases         one JARVIS refund case on the org's selected AMD model (owner-gated route flag)
//   /status        what this org may use: role, selected models, quotas, route flags (no secrets)
//   /admin-health  platform admins only: which secrets are configured (yes/no), never values
//
// Every request: CORS allowlist → method → JWT verified with Supabase Auth → size limit → strict body →
// the caller's role in the org is read under RLS with the caller's own JWT (never taken from the body) →
// the model comes from the org's selection in the server-side registry (never from the request) → the
// route must be enabled by its own flag → every provider request reserves durable quota first (atomic SQL,
// as the caller) and is completed by the service role whatever happens. Provider keys are read from
// function secrets only and never appear in a response, a log line or the database.
import { z } from "zod";
import { runBoardroom } from "./jarvis/web/src/team/orchestrator.ts";
import { scopedContext } from "./jarvis/web/src/team/context.ts";
import { loadTeamConfig, OpenRouterTeamProvider, type DispatchHooks } from "./jarvis/api/src/team/openrouter.ts";
import { loadAiConfig } from "./jarvis/api/src/ai-config.ts";
import { buildAiAdapters } from "./jarvis/api/src/ai-mode.ts";
import { runCase } from "./jarvis/api/src/case-engine.ts";
import { CaseRequestSchema } from "./jarvis/api/src/contracts.ts";
import { REFUND_POLICY } from "./jarvis/api/src/fixtures.ts";
import { freshWorld } from "./jarvis/api/src/ingress.ts";
import type { ChatClient } from "./jarvis/api/src/provider/openai-compatible-client.ts";

export const MAX_BODY_BYTES = 16 * 1024;
const PER_OPERATION_MAX_CALLS = 6;
const AMD_BASE = "https://developer.amd.com.cn/radeon/api/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export type Role = "owner" | "operator" | "viewer";

export interface ResolvedModel {
  registry_id: string;
  provider: "amd" | "openrouter";
  model_id: string;
  base_url: string;
  free_only: boolean;
  counts_for_amd: boolean;
}

export interface GatewayDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** Verifies the JWT with Supabase Auth; null when invalid or expired. */
  getUser(jwt: string): Promise<{ id: string } | null>;
  /**
   * The caller's own role in the org, read with the caller's JWT under row-level security. Must filter on
   * userId: RLS lets a member see every membership row of the org, not only their own.
   */
  roleOf(jwt: string, orgId: string, userId: string): Promise<Role | null>;
  /** Calls a SQL function as the caller (RLS and auth.uid() apply). Throws Error(message) on failure. */
  rpcAsUser(jwt: string, fn: string, args: Record<string, unknown>): Promise<unknown>;
  /** Calls a SQL function with the service role (server-only functions such as complete_model_request). */
  rpcAsService(fn: string, args: Record<string, unknown>): Promise<unknown>;
  /** Inserts with the service role (AI messages, audit and security events). */
  insertAsService(table: string, row: Record<string, unknown>): Promise<{ id?: string } | null>;
  /** Reads rows as the caller (RLS applies). */
  selectAsUser(jwt: string, table: string, columns: string, eq: Record<string, string>): Promise<Record<string, unknown>[]>;
  /** Finds or creates the caller's private conversation with one specialist, or the org boardroom, as the caller. */
  conversation(jwt: string, orgId: string, userId: string, kind: "private" | "boardroom", agent: string | null): Promise<string>;
  insertAsUser(jwt: string, table: string, row: Record<string, unknown>): Promise<void>;
  clock?: () => Date;
}

const agentId = z.enum(["ceo", "cfo", "sales", "cmo", "coo", "hr"]);
const TeamBody = z.discriminatedUnion("op", [
  z.object({ op: z.literal("reply"), orgId: z.string().uuid(), agent: agentId, question: z.string().trim().min(1).max(1200) }).strict(),
  z.object({ op: z.literal("boardroom"), orgId: z.string().uuid(), request: z.string().trim().min(1).max(2000), agents: z.array(agentId).min(1).max(6).optional() }).strict(),
]);
const CaseBody = z.object({ orgId: z.string().uuid(), request: CaseRequestSchema }).strict();
const OrgBody = z.object({ orgId: z.string().uuid() }).strict();

type Ctx = { jwt: string; user: { id: string }; cors: Record<string, string> };

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });
}

export function corsFor(origin: string | null, env: Record<string, string | undefined>): Record<string, string> | null {
  if (origin === null) return {}; // server-to-server or same-origin tools: no CORS headers needed
  const allowed = (env.JARVIS_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-headers": "authorization, content-type, apikey, x-client-info", "access-control-allow-methods": "GET, POST, OPTIONS" };
}

const codeOf = (e: unknown) => {
  const c = (e as { code?: unknown })?.code;
  if (typeof c === "string" && /^[A-Z_]+$/.test(c)) return c;
  const m = (e as { message?: unknown })?.message;
  return typeof m === "string" && /^[A-Z_]+$/.test(m) ? m : "PROVIDER_ERROR";
};

let verifiedTeamModel: { model: string; at: number } | null = null; // cold-start cache of the team startup gate
export const resetGatewayCache = () => void (verifiedTeamModel = null);

/** Shared front door: CORS, method, JWT, size, JSON. Returns a Response to send, or the context and body. */
async function admit(req: Request, deps: GatewayDeps, method: "POST" | "GET"): Promise<Response | { ctx: Ctx; raw: unknown }> {
  const cors = corsFor(req.headers.get("origin"), deps.env);
  if (cors === null) return json(403, { error: "origin_not_allowed" }, {});
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== method) return json(405, { error: "method_not_allowed" }, cors);
  const jwt = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!jwt) return json(401, { error: "unauthorized" }, cors);
  const user = await deps.getUser(jwt).catch(() => null);
  if (!user) return json(401, { error: "unauthorized" }, cors);
  if (method === "GET") return { ctx: { jwt, user, cors }, raw: null };
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(413, { error: "body_too_large" }, cors);
  try {
    return { ctx: { jwt, user, cors }, raw: JSON.parse(text) };
  } catch {
    return json(400, { error: "invalid_json" }, cors);
  }
}

async function requireOperator(ctx: Ctx, orgId: string, deps: GatewayDeps, op: string): Promise<Response | Role> {
  const role = await deps.roleOf(ctx.jwt, orgId, ctx.user.id).catch(() => null);
  if (role === "owner" || role === "operator") return role;
  await deps.insertAsService("security_events", { org_id: role ? orgId : null, user_id: ctx.user.id, kind: "gateway_denied", detail: { op, role } }).catch(() => null);
  return json(403, { error: "forbidden" }, ctx.cors);
}

async function resolveModel(ctx: Ctx, orgId: string, purpose: "team" | "case", deps: GatewayDeps): Promise<ResolvedModel | null> {
  const m = (await deps.rpcAsUser(ctx.jwt, "resolve_model", { p_org: orgId, p_purpose: purpose }).catch(() => null)) as ResolvedModel | null;
  if (!m) return null;
  // Defence in depth: the registry's own CHECK already limits base URLs; the gateway re-checks provider and URL.
  if (purpose === "team" && (m.provider !== "openrouter" || m.base_url !== OPENROUTER_BASE || !m.free_only)) return null;
  if (purpose === "case" && (m.provider !== "amd" || m.base_url !== AMD_BASE)) return null;
  return m;
}

function quotaHooks(ctx: Ctx, orgId: string, provider: "amd" | "openrouter", model: string, operation: string, deps: GatewayDeps): DispatchHooks {
  return {
    reserve: async () => String(await deps.rpcAsUser(ctx.jwt, "reserve_model_request", { p_org: orgId, p_provider: provider, p_model: model, p_operation: operation })),
    complete: async (ticket, o) => {
      await deps.rpcAsService("complete_model_request", { p_request: ticket, p_status: o.status, p_tokens_in: o.tokensIn, p_tokens_out: o.tokensOut, p_cost: o.costUsd, p_error: o.error });
    },
  };
}

// ------------------------------------------------------------------------------------------------ /team

export async function handleTeamGateway(req: Request, deps: GatewayDeps): Promise<Response> {
  const a = await admit(req, deps, "POST");
  if (a instanceof Response) return a;
  const { ctx } = a;
  const p = TeamBody.safeParse(a.raw);
  if (!p.success) return json(400, { error: "invalid_request" }, ctx.cors);
  const body = p.data;
  const role = await requireOperator(ctx, body.orgId, deps, `team.${body.op}`);
  if (role instanceof Response) return role;

  const selected = await resolveModel(ctx, body.orgId, "team", deps);
  if (!selected) return json(503, { error: "team_model_not_selected" }, ctx.cors);
  let cfg;
  try {
    cfg = loadTeamConfig({
      JARVIS_TEAM_PROVIDER: deps.env.JARVIS_TEAM_API_KEY ? "openrouter" : undefined,
      JARVIS_TEAM_API_KEY: deps.env.JARVIS_TEAM_API_KEY,
      JARVIS_TEAM_MODEL: selected.model_id,
      JARVIS_TEAM_BASE_URL: deps.env.JARVIS_TEAM_TEST_BASE_URL, // loopback mocks in tests only; loadTeamConfig refuses anything else
      JARVIS_TEAM_MAX_REQUESTS: String(PER_OPERATION_MAX_CALLS),
      JARVIS_TEAM_FREE_ONLY: "1",
      JARVIS_TEAM_MAX_OUTPUT_TOKENS: deps.env.JARVIS_TEAM_MAX_OUTPUT_TOKENS,
      JARVIS_TEAM_TIMEOUT_MS: deps.env.JARVIS_TEAM_TIMEOUT_MS,
    });
  } catch {
    return json(503, { error: "team_misconfigured" }, ctx.cors);
  }
  if (!cfg) return json(503, { error: "team_not_configured" }, ctx.cors);
  // Configuring the secret is not consent to spend: live calls need this flag set separately by the owner.
  if (deps.env.JARVIS_TEAM_LIVE_ENABLED !== "1") return json(503, { error: "live_inference_not_enabled" }, ctx.cors);

  const operation = body.op === "reply" ? "team_reply" : "team_boardroom";
  const provider = new OpenRouterTeamProvider(cfg, deps.fetch, quotaHooks(ctx, body.orgId, "openrouter", cfg.model, operation, deps));
  try {
    if (!verifiedTeamModel || verifiedTeamModel.model !== cfg.model || Date.now() - verifiedTeamModel.at > 10 * 60_000) {
      await provider.verifyModel(); // listing + zero price + key limit; no inference
      verifiedTeamModel = { model: cfg.model, at: Date.now() };
    }
  } catch (e) {
    return json(503, { error: codeOf(e) }, ctx.cors);
  }

  const provenance = { kind: "live", provider: "openrouter", model: cfg.model, registry: selected.registry_id };
  if (body.op === "reply") {
    const conv = await deps.conversation(ctx.jwt, body.orgId, ctx.user.id, "private", body.agent);
    await deps.insertAsUser(ctx.jwt, "messages", { conversation_id: conv, org_id: body.orgId, author_kind: "human", author_user_id: ctx.user.id, text: body.question });
    try {
      const r = await provider.reply(body.agent, body.question, scopedContext(body.agent), AbortSignal.timeout(60_000));
      await deps.insertAsService("messages", { conversation_id: conv, org_id: body.orgId, author_kind: "ai", agent: body.agent, provenance, text: r.text.slice(0, 4000), withheld_statements: r.withheld });
      return json(200, { text: r.text, evidence: r.evidence, withheld: r.withheld, provider: r.provider, usage: provider.usage() }, ctx.cors);
    } catch (e) {
      return json(502, { error: codeOf(e) }, ctx.cors);
    }
  }

  const result = await runBoardroom(body.request, provider, { agents: body.agents, budgets: { maxCalls: PER_OPERATION_MAX_CALLS, perCallTimeoutMs: 60_000 } });
  const board = await deps.conversation(ctx.jwt, body.orgId, ctx.user.id, "boardroom", null);
  for (const an of result.analyses) {
    if (an.status !== "ok" || !an.output) continue;
    const text = an.output.findings.map((f) => `${f.kind === "measured" ? "Measured" : "Hypothesis"}: ${f.text}`).join("\n").slice(0, 4000);
    await deps.insertAsService("messages", { conversation_id: board, org_id: body.orgId, author_kind: "ai", agent: an.agent, provenance, text });
  }
  await deps.insertAsService("audit_events", {
    org_id: body.orgId, actor_kind: "user", actor_id: ctx.user.id, operation: "team.boardroom", provider: "openrouter", model: cfg.model,
    execution_result: result.analyses.every((x) => x.status === "ok") ? "all_ok" : "partial",
    detail: { selected: result.selected, statuses: result.analyses.map((x) => [x.agent, x.status]), actions: result.report.actions.length, figureRejections: result.audit.filter((e) => e.type === "FIGURE_REJECTED").length },
  });
  return json(200, { ...result, usage: provider.usage() }, ctx.cors);
}

// ------------------------------------------------------------------------------------------------ /cases

export async function handleCase(req: Request, deps: GatewayDeps): Promise<Response> {
  const a = await admit(req, deps, "POST");
  if (a instanceof Response) return a;
  const { ctx } = a;
  const p = CaseBody.safeParse(a.raw);
  if (!p.success) return json(400, { error: "invalid_request" }, ctx.cors);
  const body = p.data;
  const role = await requireOperator(ctx, body.orgId, deps, "case.run");
  if (role instanceof Response) return role;
  // The AMD key was exposed earlier: its route stays off unless the owner sets this flag, and every call
  // still needs a positive daily AMD quota for the org (default 0).
  if (deps.env.JARVIS_AMD_ROUTE_ENABLED !== "1") return json(503, { error: "amd_route_not_enabled" }, ctx.cors);
  if (!deps.env.JARVIS_MODEL_API_KEY) return json(503, { error: "amd_not_configured" }, ctx.cors);
  const selected = await resolveModel(ctx, body.orgId, "case", deps);
  if (!selected) return json(503, { error: "case_model_not_selected" }, ctx.cors);

  const testBase = deps.env.JARVIS_MODEL_TEST_BASE_URL;
  if (testBase !== undefined && !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(testBase)) return json(503, { error: "amd_misconfigured" }, ctx.cors);
  let config;
  try {
    config = loadAiConfig({
      JARVIS_AI_MODE: "vllm",
      JARVIS_MODEL_BASE_URL: deps.env.JARVIS_MODEL_TEST_BASE_URL ?? selected.base_url, // loopback mocks in tests only
      JARVIS_MODEL_NAME: selected.model_id,
      JARVIS_MODEL_API_KEY: deps.env.JARVIS_MODEL_API_KEY,
      JARVIS_MODEL_TIMEOUT_MS: "60000",
      JARVIS_MODEL_MAX_RETRIES: "0", // no automatic retries: each call is reserved and counted once
      JARVIS_MODEL_STRUCTURED_OUTPUT: "json_object",
    } as never);
  } catch {
    return json(503, { error: "amd_misconfigured" }, ctx.cors);
  }
  const hooksFor = (stage: string) => quotaHooks(ctx, body.orgId, "amd", selected.model_id, stage === "UNDERSTANDING" ? "case_understanding" : "case_proposal", deps);
  const runtime = buildAiAdapters(config, {
    wrapClient: (client: ChatClient, stage) => ({
      model: client.model,
      async chatCompletions(params) {
        const h = hooksFor(stage);
        let ticket: string;
        try {
          ticket = await h.reserve();
        } catch (e) {
          throw new Error(codeOf(e) === "QUOTA_EXHAUSTED" ? "QUOTA_EXHAUSTED" : "QUOTA_RESERVATION_FAILED");
        }
        try {
          const r = await client.chatCompletions(params);
          await h.complete(ticket, { status: "completed", tokensIn: r.usage?.promptTokens ?? null, tokensOut: r.usage?.completionTokens ?? null, costUsd: null, error: null });
          return r;
        } catch (e) {
          await h.complete(ticket, { status: "failed", tokensIn: null, tokensOut: null, costUsd: null, error: codeOf(e) }).catch(() => undefined);
          throw e;
        }
      },
    }),
  });

  const clock = deps.clock ?? (() => new Date());
  const world = freshWorld(clock); // synthetic store; payments are simulated
  const c = await runCase(body.request, {
    ...world,
    understanding: runtime.understanding,
    model: runtime.model,
    policy: REFUND_POLICY,
    permissions: { autoRefund: true },
    clock,
    modelTimeoutMs: runtime.engineTimeoutMs,
  });
  let recordId: string | null = null;
  try {
    recordId = String(await deps.rpcAsService("record_case", { p_org: body.orgId, p_user: ctx.user.id, p_case: c, p_policy_version: REFUND_POLICY.version }));
  } catch {
    // The case ran; failing to persist it is reported, never hidden.
    return json(500, { error: "case_not_recorded", case: c }, ctx.cors);
  }
  return json(200, { record: recordId, model: { provider: "amd", model: selected.model_id, registry: selected.registry_id }, case: c }, ctx.cors);
}

// ------------------------------------------------------------------------------------------------ /status

export async function handleStatus(req: Request, deps: GatewayDeps): Promise<Response> {
  const a = await admit(req, deps, "POST");
  if (a instanceof Response) return a;
  const { ctx } = a;
  const p = OrgBody.safeParse(a.raw);
  if (!p.success) return json(400, { error: "invalid_request" }, ctx.cors);
  const role = await deps.roleOf(ctx.jwt, p.data.orgId, ctx.user.id).catch(() => null);
  if (!role) return json(403, { error: "forbidden" }, ctx.cors);
  const [team, cases, quotas, usage] = await Promise.all([
    resolveModel(ctx, p.data.orgId, "team", deps),
    resolveModel(ctx, p.data.orgId, "case", deps),
    deps.selectAsUser(ctx.jwt, "quota_policies", "provider,daily_max_requests,max_output_tokens", { org_id: p.data.orgId }).catch(() => []),
    deps.selectAsUser(ctx.jwt, "usage_counters", "provider,window_start,max_requests,used", { org_id: p.data.orgId }).catch(() => []),
  ]);
  return json(200, {
    role,
    models: { team, case: cases },
    routes: { teamLive: deps.env.JARVIS_TEAM_LIVE_ENABLED === "1", amdCases: deps.env.JARVIS_AMD_ROUTE_ENABLED === "1" },
    quotas,
    usage,
  }, ctx.cors);
}

// ------------------------------------------------------------------------------------------------ /admin-health

/** Platform-admin health check. Reports only booleans and public facts; never a key or any part of one. */
export async function handleAdminHealth(req: Request, deps: Pick<GatewayDeps, "env" | "fetch" | "getUser"> & { isPlatformAdmin(userId: string): Promise<boolean> }): Promise<Response> {
  const cors = corsFor(req.headers.get("origin"), deps.env);
  if (cors === null) return json(403, { error: "origin_not_allowed" }, {});
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const jwt = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const user = jwt ? await deps.getUser(jwt).catch(() => null) : null;
  if (!user || !(await deps.isPlatformAdmin(user.id).catch(() => false))) return json(403, { error: "forbidden" }, cors);
  const e = deps.env;
  const set = (k: string) => typeof e[k] === "string" && e[k]!.trim().length > 0;
  const body: Record<string, unknown> = {
    amdCredentialConfigured: set("JARVIS_MODEL_API_KEY"),
    openRouterCredentialConfigured: set("JARVIS_TEAM_API_KEY"),
    teamLiveEnabled: e.JARVIS_TEAM_LIVE_ENABLED === "1",
    amdRouteEnabled: e.JARVIS_AMD_ROUTE_ENABLED === "1",
    allowedOrigins: (e.JARVIS_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean).length,
    auth: "pass",
  };
  // Public model listing only (no key sent): are the registry's models listed, and the free one at zero price?
  if (new URL(req.url).searchParams.get("probe") === "models") {
    try {
      const res = await deps.fetch(`${OPENROUTER_BASE}/models`, { signal: AbortSignal.timeout(10_000) });
      const list = ((await res.json()) as { data?: { id: string; pricing?: Record<string, string> }[] }).data ?? [];
      const m = list.find((x) => x.id === "nvidia/nemotron-3-super-120b-a12b:free");
      body.teamDefaultModelListed = Boolean(m);
      body.teamDefaultModelFree = Boolean(m && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
    } catch {
      body.teamDefaultModelListed = "unreachable";
    }
  }
  body.securityGate = body.allowedOrigins !== 0 ? "pass" : "fail";
  return json(200, body, cors);
}

/** Router used by the Edge Function entry point. */
export function route(req: Request, deps: GatewayDeps & { isPlatformAdmin(userId: string): Promise<boolean> }): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (path.endsWith("/admin-health")) return handleAdminHealth(req, deps);
  if (path.endsWith("/team")) return handleTeamGateway(req, deps);
  if (path.endsWith("/cases")) return handleCase(req, deps);
  if (path.endsWith("/status")) return handleStatus(req, deps);
  return Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } }));
}
