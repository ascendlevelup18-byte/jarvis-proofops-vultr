// Case ingress shared by every entry point (node:http server, Netlify, Vercel).
// Order, all before any model call: method → size → JSON → schema → request class →
// access token (privileged only) → cost limits → run.
//
// Request classes:
// - public demo: the request is exactly one of the four canonical scenarios. No token.
//   Each run gets a fresh synthetic store and simulated gateway, so runs are repeatable
//   and never affect each other.
// - privileged: anything else. Requires the server-side bearer token; refused outright
//   when no token is configured. Knowing an order id is not authentication.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AiMode } from "./ai-config.ts";
import { runCase, type EngineDeps } from "./case-engine.ts";
import { CaseRequestSchema, type CaseRequest } from "./contracts.ts";
import { CommerceStore, REFUND_POLICY, SCENARIOS, seedFixtures } from "./fixtures.ts";
import { SimulatedPaymentGateway } from "./gateway.ts";
import type { InferenceLimiter, LimitDenial } from "./limits.ts";
import type { ModelAdapter } from "./model-adapter.ts";
import type { RequestUnderstandingAdapter } from "./request-understanding.ts";

export const MAX_BODY_BYTES = 64 * 1024;

// Ids match apps/web/src/fixtures/demo-scenarios.ts.
export const PUBLIC_DEMOS = {
  "valid-duplicate": SCENARIOS.validDuplicate,
  "conflicting-amount": SCENARIOS.conflictingAmount,
  "already-refunded": SCENARIOS.alreadyRefunded,
  "prompt-injection": SCENARIOS.promptInjection,
} as const satisfies Record<string, CaseRequest>;
export type DemoId = keyof typeof PUBLIC_DEMOS;

export function matchPublicDemo(r: CaseRequest): DemoId | null {
  for (const [id, s] of Object.entries(PUBLIC_DEMOS) as [DemoId, CaseRequest][]) {
    if (r.customerId === s.customerId && r.orderId === s.orderId && r.message === s.message) return id;
  }
  return null;
}

export interface World {
  store: CommerceStore;
  gateway: SimulatedPaymentGateway;
}

/** A fresh synthetic world: seeded store + simulated gateway, shared with nothing. */
export function freshWorld(clock: () => Date): World {
  const store = new CommerceStore();
  seedFixtures(store, clock());
  return { store, gateway: new SimulatedPaymentGateway(store, clock) };
}

export interface CaseIngress {
  aiMode: AiMode;
  understanding: RequestUnderstandingAdapter;
  model: ModelAdapter;
  engineTimeoutMs: number;
  /** Provider calls to reserve from the budget per case (default: vllm 2, fixture 0). */
  modelCallsPerCase?: number;
  accessToken: string | null;
  limiter: InferenceLimiter;
  /** World for privileged cases (long-running server: one persistent world). */
  privilegedWorld: () => World;
  clock: () => Date;
  /** One entry per handled request: no message text, no token. */
  log?: (entry: Record<string, unknown>) => void;
  /**
   * Optional lazy runtime (serverless real-model mode): called only for requests that
   * passed the access guard, before any budget is reserved. Overrides the adapter fields.
   */
  resolveRuntime?: () => Promise<
    | { ok: true; runtime: Pick<CaseIngress, "aiMode" | "understanding" | "model" | "engineTimeoutMs" | "modelCallsPerCase"> }
    | { ok: false; status: number; body: unknown }
  >;
}

export interface IngressRequest {
  method: string;
  /** null when the body exceeded MAX_BODY_BYTES while reading. */
  bodyText: string | null;
  authorization: string | undefined;
  clientKey: string;
}

export interface IngressResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

const DENIAL_BODY: Record<LimitDenial, string> = {
  RATE_LIMITED: "rate_limited",
  CONCURRENCY_LIMITED: "concurrency_limited",
  BUDGET_EXHAUSTED: "budget_exhausted",
};

export async function handleCaseRequest(req: IngressRequest, ing: CaseIngress): Promise<IngressResponse> {
  const started = performance.now();
  const base: Record<string, string> = { "x-jarvis-ai-mode": ing.aiMode, "x-jarvis-payments": "simulated" };
  const reply = (status: number, body: unknown, extra: Record<string, string> = {}, logged: Record<string, unknown> = {}) => {
    ing.log?.({ status, ...logged, latencyMs: Math.round(performance.now() - started) });
    return { status, body, headers: { ...base, ...extra } };
  };

  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (req.bodyText === null || Buffer.byteLength(req.bodyText, "utf8") > MAX_BODY_BYTES) {
    return reply(413, { error: "body_too_large" });
  }
  let json: unknown;
  try {
    json = JSON.parse(req.bodyText);
  } catch {
    return reply(400, { error: "invalid_json" });
  }
  const parsed = CaseRequestSchema.safeParse(json);
  if (!parsed.success) {
    return reply(400, {
      error: "invalid_request",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const demo = matchPublicDemo(parsed.data);
  const requestClass = demo ? "demo" : "privileged";
  if (!demo) {
    if (ing.accessToken === null) {
      return reply(403, { error: "free_text_disabled", detail: "only the four public demo scenarios are accepted" }, {}, { requestClass });
    }
    if (!bearerMatches(req.authorization, ing.accessToken)) {
      return reply(
        401,
        { error: "unauthorized", detail: "only the four public demo scenarios run without an access token" },
        { "www-authenticate": "Bearer" },
        { requestClass },
      );
    }
  }

  let rt: Pick<CaseIngress, "aiMode" | "understanding" | "model" | "engineTimeoutMs" | "modelCallsPerCase"> = ing;
  if (ing.resolveRuntime) {
    const resolved = await ing.resolveRuntime();
    if (!resolved.ok) return reply(resolved.status, resolved.body, {}, { requestClass, denied: "RUNTIME_UNAVAILABLE" });
    rt = resolved.runtime;
    base["x-jarvis-ai-mode"] = rt.aiMode;
  }

  const slot = ing.limiter.tryAcquire(req.clientKey, rt.modelCallsPerCase ?? (rt.aiMode === "vllm" ? 2 : 0));
  if (!slot.ok) {
    return reply(
      429,
      { error: DENIAL_BODY[slot.reason], retryAfterSec: slot.retryAfterSec },
      { "retry-after": String(slot.retryAfterSec) },
      { requestClass, denied: slot.reason },
    );
  }

  try {
    const world = demo ? freshWorld(ing.clock) : ing.privilegedWorld();
    const deps: EngineDeps = {
      ...world,
      understanding: rt.understanding,
      model: rt.model,
      policy: REFUND_POLICY,
      permissions: { autoRefund: true },
      clock: ing.clock,
      modelTimeoutMs: rt.engineTimeoutMs,
    };
    const c = await runCase(parsed.data, deps);
    const runId = demo ? `DEMO-${randomUUID()}` : null;
    return reply(
      200,
      c,
      { "x-jarvis-request-class": requestClass, ...(demo && runId ? { "x-jarvis-demo-scenario": demo, "x-jarvis-demo-run": runId } : {}) },
      { requestClass, demo, runId, caseId: c.id, state: c.state },
    );
  } finally {
    slot.release();
  }
}

// Constant-time comparison over fixed-length digests (no length leak, no throw).
function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(m[1]!), digest(token));
}

/** Client key for rate limiting. Proxy headers are trusted only when configured. */
export function clientKeyFrom(remoteAddress: string | undefined, forwardedFor: string | undefined, trustProxy: boolean): string {
  const forwarded = trustProxy ? forwardedFor?.split(",")[0]?.trim() : undefined;
  return forwarded || remoteAddress || "unknown";
}
