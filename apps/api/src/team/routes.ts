// Operator-only AI Team endpoints on the long-running Node server (never on the public serverless demo):
//   GET  /team/status     provider, model and process-local usage
//   POST /team/boardroom  { request, shared? }        → BoardroomResult
//   POST /team/reply      { agent, question }         → { text, evidence, provider }
// Every call needs the server's bearer token. One team request runs at a time per process.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { scopedContext } from "../../../web/src/team/context.ts";
import { runBoardroom } from "../../../web/src/team/orchestrator.ts";
import type { OpenRouterTeamProvider } from "./openrouter.ts";

export const TEAM_MAX_BODY_BYTES = 16 * 1024;

export interface TeamDeps {
  provider: OpenRouterTeamProvider | null;
  accessToken: string | null;
}

type Out = { status: number; body: unknown; headers?: Record<string, string> };

const agentId = z.enum(["ceo", "cfo", "sales", "cmo", "coo", "hr"]);
const BoardroomBody = z.object({
  request: z.string().trim().min(1).max(2000),
  shared: z.array(z.object({ from: agentId, messageId: z.string().max(40), text: z.string().max(1200) })).max(10).default([]),
  /** Optional staged run: only these specialists are called (at most six calls in any case). */
  agents: z.array(agentId).min(1).max(6).optional(),
}).strict();
const ReplyBody = z.object({ agent: agentId, question: z.string().trim().min(1).max(1200) }).strict();

function bearerOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const d = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(d(m[1]!), d(token));
}

let busy = false;

/** Provider errors are reduced to a code; messages never include request headers or the key. */
const safeError = (e: unknown) => {
  const code = (e as { code?: string })?.code;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "PROVIDER_ERROR";
};

export async function handleTeamRequest(path: string, method: string, authorization: string | undefined, bodyText: string | null, deps: TeamDeps): Promise<Out> {
  if (!deps.provider) return { status: 404, body: { error: "team_live_disabled" } };
  if (deps.accessToken === null) return { status: 403, body: { error: "team_requires_operator_token" } };
  if (!bearerOk(authorization, deps.accessToken)) return { status: 401, body: { error: "unauthorized" }, headers: { "www-authenticate": "Bearer" } };

  if (path === "/team/status") {
    if (method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
    return { status: 200, body: { provider: deps.provider.info, usage: deps.provider.usage() } };
  }
  if (path !== "/team/boardroom" && path !== "/team/reply") return { status: 404, body: { error: "not_found" } };
  if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  if (bodyText === null) return { status: 413, body: { error: "body_too_large", limitBytes: TEAM_MAX_BODY_BYTES } };
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (busy) return { status: 429, body: { error: "team_busy", detail: "one team request at a time" }, headers: { "retry-after": "5" } };
  busy = true;
  try {
    if (path === "/team/boardroom") {
      const p = BoardroomBody.safeParse(json);
      if (!p.success) return { status: 400, body: { error: "invalid_request" } };
      const result = await runBoardroom(p.data.request, deps.provider, { shared: p.data.shared, agents: p.data.agents, budgets: { perCallTimeoutMs: 125000, maxCalls: 6 } });
      return { status: 200, body: { ...result, usage: deps.provider.usage() } };
    }
    const p = ReplyBody.safeParse(json);
    if (!p.success) return { status: 400, body: { error: "invalid_request" } };
    try {
      const r = await deps.provider.reply(p.data.agent, p.data.question, scopedContext(p.data.agent), AbortSignal.timeout(125000));
      return { status: 200, body: { ...r, usage: deps.provider.usage() } };
    } catch (e) {
      return { status: 502, body: { error: safeError(e) } };
    }
  } finally {
    busy = false;
  }
}
