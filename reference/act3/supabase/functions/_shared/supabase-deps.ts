// Deno wiring for the gateway: Supabase clients built from the variables the Edge runtime provides
// (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY). The service-role client never leaves this
// module, and every tenant check runs with the caller's own JWT.
import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";
import type { GatewayDeps, Role } from "./gateway.ts";

// The reused Node engine reads response bodies with Buffer, which Deno only provides as a module.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const asUser = (jwt: string) => createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } });

const ENV_NAMES = ["JARVIS_TEAM_API_KEY", "JARVIS_TEAM_MAX_OUTPUT_TOKENS", "JARVIS_TEAM_TIMEOUT_MS", "JARVIS_TEAM_FREE_ONLY",
  "JARVIS_TEAM_LIVE_ENABLED", "JARVIS_ALLOWED_ORIGINS", "JARVIS_MODEL_API_KEY", "JARVIS_AMD_ROUTE_ENABLED"];

export function denoDeps(): GatewayDeps & { isPlatformAdmin(userId: string): Promise<boolean> } {
  // Only the named secrets are read; the gateway never sees the rest of the environment.
  const env = Object.fromEntries(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
  return {
    env,
    fetch: globalThis.fetch.bind(globalThis),
    async getUser(jwt) {
      const { data, error } = await service.auth.getUser(jwt);
      return error || !data.user ? null : { id: data.user.id };
    },
    async roleOf(jwt, orgId, userId) {
      // RLS shows every member's row in the org; only the caller's own row decides their role.
      const { data, error } = await asUser(jwt).from("memberships").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
      return error || !data ? null : (data.role as Role);
    },
    async rpcAsUser(jwt, fn, args) {
      const { data, error } = await asUser(jwt).rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    },
    async rpcAsService(fn, args) {
      const { data, error } = await service.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    },
    async insertAsService(table, row) {
      const { data, error } = await service.from(table).insert(row).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      return data as { id?: string } | null;
    },
    async selectAsUser(jwt, table, columns, eq) {
      let q = asUser(jwt).from(table).select(columns);
      for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as Record<string, unknown>[];
    },
    async insertAsUser(jwt, table, row) {
      const { error } = await asUser(jwt).from(table).insert(row);
      if (error) throw new Error(error.message);
    },
    async conversation(jwt, orgId, userId, kind, agent) {
      const db = asUser(jwt);
      let q = db.from("conversations").select("id").eq("org_id", orgId).eq("kind", kind);
      q = kind === "private" ? q.eq("owner_id", userId).eq("agent", agent!) : q;
      const found = await q.order("created_at").limit(1).maybeSingle();
      if (found.data) return found.data.id as string;
      const made = await db.from("conversations").insert({ org_id: orgId, owner_id: userId, kind, agent }).select("id").single();
      if (made.error) throw new Error(made.error.message);
      return made.data.id as string;
    },
    async isPlatformAdmin(userId) {
      const { data } = await service.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
      return Boolean(data);
    },
  };
}
