// Inference cost protection for case ingress: per-client rate limit, global concurrency
// cap and a daily model-call budget, checked before any case runs.
//
// LocalInferenceLimiter is in-process memory. It is a real global limit only for a single
// long-running server process. On serverless (Netlify/Vercel) each instance has its own
// counters, so it is NOT a global limit there; serverless ingress is fixture-only for that
// reason. Public real-model exposure needs an externally enforced limiter first.

export interface IngressLimits {
  /** Cases running at once, across all clients. */
  maxConcurrent: number;
  /** Accepted cases per client per rolling minute. */
  perClientPerMinute: number;
  /** Model calls reserved per UTC day (vllm: 2 per case; fixture cases reserve 0). */
  dailyModelCallBudget: number;
}

export type LimitDenial = "RATE_LIMITED" | "CONCURRENCY_LIMITED" | "BUDGET_EXHAUSTED";

export type Acquired = { ok: true; release: () => void };
export type Denied = { ok: false; reason: LimitDenial; retryAfterSec: number };

export interface InferenceLimiter {
  /** Reserves capacity for one case that may make up to `modelCalls` model calls. */
  tryAcquire(clientKey: string, modelCalls: number): Acquired | Denied;
}

const WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 10_000;

export class LocalInferenceLimiter implements InferenceLimiter {
  readonly #limits: IngressLimits;
  readonly #now: () => number;
  readonly #recent = new Map<string, number[]>();
  #active = 0;
  #budgetDay = "";
  #budgetUsed = 0;

  constructor(limits: IngressLimits, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
  }

  tryAcquire(clientKey: string, modelCalls: number): Acquired | Denied {
    const now = this.#now();

    const recent = (this.#recent.get(clientKey) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= this.#limits.perClientPerMinute) {
      return { ok: false, reason: "RATE_LIMITED", retryAfterSec: Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - now) / 1000)) };
    }
    if (this.#active >= this.#limits.maxConcurrent) {
      return { ok: false, reason: "CONCURRENCY_LIMITED", retryAfterSec: 1 };
    }
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.#budgetDay) {
      this.#budgetDay = day;
      this.#budgetUsed = 0;
    }
    if (this.#budgetUsed + modelCalls > this.#limits.dailyModelCallBudget) {
      const nextDay = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
      return { ok: false, reason: "BUDGET_EXHAUSTED", retryAfterSec: Math.max(1, Math.ceil((nextDay - now) / 1000)) };
    }

    // Reserve. Budget is not refunded when a case fails early: conservative by design.
    this.#budgetUsed += modelCalls;
    this.#active++;
    recent.push(now);
    this.#recent.delete(clientKey);
    this.#recent.set(clientKey, recent);
    if (this.#recent.size > MAX_TRACKED_CLIENTS) this.#recent.delete(this.#recent.keys().next().value!);

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#active--;
      },
    };
  }
}

export class IngressConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngressConfigError";
  }
}

export interface IngressSecurityConfig {
  /** Server-side token for privileged free-text cases; null disables free text entirely. */
  accessToken: string | null;
  limits: IngressLimits;
  /** Use the first X-Forwarded-For hop as the client key (only behind a trusted proxy). */
  trustProxy: boolean;
}

const MIN_TOKEN_LENGTH = 24;

/**
 * - JARVIS_CASES_TOKEN: optional; >= 24 chars. Absent → free-text cases are refused.
 * - JARVIS_MAX_CONCURRENT_CASES (default 2), JARVIS_RATE_LIMIT_PER_MINUTE (default 30)
 * - JARVIS_DAILY_MODEL_CALL_BUDGET: required in vllm mode (paid inference needs an explicit
 *   budget); fixture default 200 (fixture cases reserve 0 calls anyway).
 * - JARVIS_TRUST_PROXY: "1" to key rate limits on X-Forwarded-For.
 */
export function loadIngressSecurity(env: NodeJS.ProcessEnv, mode: "fixture" | "vllm"): IngressSecurityConfig {
  const token = env.JARVIS_CASES_TOKEN?.trim() || null;
  if (token !== null && token.length < MIN_TOKEN_LENGTH) {
    throw new IngressConfigError(`JARVIS_CASES_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (mode === "vllm" && !env.JARVIS_DAILY_MODEL_CALL_BUDGET?.trim()) {
    throw new IngressConfigError("JARVIS_AI_MODE=vllm requires an explicit JARVIS_DAILY_MODEL_CALL_BUDGET");
  }
  return {
    accessToken: token,
    limits: {
      maxConcurrent: positiveInt(env, "JARVIS_MAX_CONCURRENT_CASES", 2),
      perClientPerMinute: positiveInt(env, "JARVIS_RATE_LIMIT_PER_MINUTE", 30),
      dailyModelCallBudget: positiveInt(env, "JARVIS_DAILY_MODEL_CALL_BUDGET", 200),
    },
    trustProxy: env.JARVIS_TRUST_PROXY === "1",
  };
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new IngressConfigError(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  return n;
}
