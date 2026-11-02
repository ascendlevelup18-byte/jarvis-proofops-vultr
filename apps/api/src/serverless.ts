// Web-standard (Request → Response) handlers for serverless hosts (Netlify, Vercel).
// Same ingress guard and engine as the node:http server. Serverless rules:
// - Fixture by default. Real-model (OpenAI-compatible, e.g. AMD-hosted) inference runs
//   only with JARVIS_AI_MODE=vllm AND JARVIS_SERVERLESS_REAL_MODEL=enabled AND an explicit
//   daily budget. Otherwise a vllm config refuses cases (503); it never falls back to fixtures.
// - Real-model mode runs the same fail-closed startup checks (model listed + schema
//   probes) once per function instance before serving; a failed check is a 503 and is
//   retried on the next request.
// - No shared business state: every case, demo or privileged, gets a fresh world.
// - Limits are per serverless instance (in memory), NOT global; health says so.
// - The model API key is read from server-side env only; nothing here reaches the browser.
import { loadAiConfig, AiConfigError, resolveModelTimeouts, sanitizeEndpoint } from "./ai-config.ts";
import { initializeAi, type AiRuntime, type AiStartupReport } from "./ai-mode.ts";
import { demoStoreSnapshot } from "./demo-store.ts";
import { handleCaseRequest, freshWorld, MAX_BODY_BYTES } from "./ingress.ts";
import { IngressConfigError, loadIngressSecurity, LocalInferenceLimiter, type IngressLimits } from "./limits.ts";
import { FixtureModelAdapter } from "./model-adapter.ts";
import { isProviderError, OpenAICompatibleClient } from "./provider/index.ts";
import { FixtureRequestUnderstandingAdapter } from "./request-understanding.ts";

const PROVIDER_CHECK_TTL_MS = 60_000;

/**
 * Reads at most `max` bytes of a request body. Returns null (the ingress answers 413) as soon
 * as the declared length or the bytes actually received exceed the limit, so an oversized
 * body is never buffered whole. Decodes as UTF-8 like Request.text().
 */
export async function readBoundedText(request: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

interface ProviderCheck {
  checkedAt: string;
  endpoint: string | null;
  reachable: boolean;
  modelListed: boolean | null;
  error: string | null;
}

// Cheap provider diagnostic for health: GET /models only (no completion, no tokens).
async function checkProvider(env: NodeJS.ProcessEnv): Promise<ProviderCheck> {
  const checkedAt = new Date().toISOString();
  try {
    const config = loadAiConfig(env);
    const client = new OpenAICompatibleClient({
      baseUrl: config.modelBaseUrl!,
      model: config.modelName!,
      ...(config.modelApiKey ? { apiKey: config.modelApiKey } : {}),
      timeoutMs: Math.min(resolveModelTimeouts(config).engineTimeoutMs, 5000),
    });
    const ids = await client.listModels();
    // Every configured model must be served (the understanding model may differ from the decision model).
    const wanted = [client.model, config.understandingModelName ?? client.model];
    return { checkedAt, endpoint: sanitizeEndpoint(client.baseUrl), reachable: true, modelListed: wanted.every((m) => ids.includes(m)), error: null };
  } catch (e) {
    const error = isProviderError(e) ? `${e.category}: ${e.message}` : e instanceof Error ? e.message : String(e);
    const key = env.JARVIS_MODEL_API_KEY?.trim();
    return {
      checkedAt,
      endpoint: env.JARVIS_MODEL_BASE_URL ? sanitizeEndpoint(env.JARVIS_MODEL_BASE_URL) : null,
      reachable: false,
      modelListed: null,
      error: key ? error.split(key).join("[REDACTED]") : error,
    };
  }
}

export type ServerlessDeployment = "netlify" | "vercel";

const FIXTURE_ENGINE_TIMEOUT_MS = 10_000;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

function configuredMode(env: NodeJS.ProcessEnv): string {
  return (env.JARVIS_AI_MODE ?? "fixture").trim().toLowerCase();
}

function realModelEnabled(env: NodeJS.ProcessEnv): boolean {
  return configuredMode(env) === "vllm" && env.JARVIS_SERVERLESS_REAL_MODEL?.trim() === "enabled";
}

// Platform-set client address headers (not user-controllable on these platforms).
function clientKey(request: Request, deployment: ServerlessDeployment): string {
  const h = request.headers;
  const ip = deployment === "netlify" ? h.get("x-nf-client-connection-ip") : h.get("x-real-ip");
  return ip || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

const FIXTURE_RUNTIME: AiRuntime = {
  mode: "fixture",
  understanding: new FixtureRequestUnderstandingAdapter(),
  model: new FixtureModelAdapter(),
  engineTimeoutMs: FIXTURE_ENGINE_TIMEOUT_MS,
  modelCallsPerCase: 0,
};

export function createServerlessHandlers(deployment: ServerlessDeployment, env: NodeJS.ProcessEnv = process.env) {
  let limiter: { key: string; instance: LocalInferenceLimiter } | null = null;
  const limiterFor = (limits: IngressLimits) => {
    const key = JSON.stringify(limits);
    if (limiter?.key !== key) limiter = { key, instance: new LocalInferenceLimiter(limits) };
    return limiter.instance;
  };

  // Real-model runtime, started once per instance; cleared on failure so the next request retries.
  let realModel: Promise<{ runtime: AiRuntime; startup: AiStartupReport }> | null = null;
  const startRealModel = () => {
    realModel ??= initializeAi(loadAiConfig(env), {
      onCall: (entry) => console.log("[jarvis] model call:", JSON.stringify({ deployment, ...entry })),
    }).catch((e: unknown) => {
      realModel = null;
      throw e;
    });
    return realModel;
  };

  async function cases(request: Request): Promise<Response> {
    const real = realModelEnabled(env);
    const runtimeHeader = { "x-jarvis-runtime": `${deployment}-${real ? "real-model" : "fixture"}-demo` };
    if (configuredMode(env) !== "fixture" && !real) {
      return json(
        503,
        { error: "serverless_is_fixture_only", detail: "set JARVIS_SERVERLESS_REAL_MODEL=enabled to serve a real model here" },
        runtimeHeader,
      );
    }
    let security;
    try {
      security = loadIngressSecurity(env, real ? "vllm" : "fixture");
    } catch (e) {
      if (e instanceof IngressConfigError) return json(503, { error: "ingress_misconfigured", detail: e.message }, runtimeHeader);
      throw e;
    }

    const clock = () => new Date();
    const r = await handleCaseRequest(
      {
        method: request.method,
        bodyText: request.method === "POST" ? await readBoundedText(request) : "",
        authorization: request.headers.get("authorization") ?? undefined,
        clientKey: clientKey(request, deployment),
      },
      {
        aiMode: FIXTURE_RUNTIME.mode,
        understanding: FIXTURE_RUNTIME.understanding,
        model: FIXTURE_RUNTIME.model,
        engineTimeoutMs: FIXTURE_RUNTIME.engineTimeoutMs,
        modelCallsPerCase: 0,
        // Real-model startup only for requests that passed the access guard.
        ...(real
          ? {
              resolveRuntime: async () => {
                try {
                  const { runtime } = await startRealModel();
                  return { ok: true as const, runtime: { ...runtime, aiMode: runtime.mode } };
                } catch (e) {
                  const detail = e instanceof AiConfigError ? `config: ${e.message}` : e instanceof Error ? e.message : String(e);
                  return { ok: false as const, status: 503, body: { error: "model_unavailable", detail } };
                }
              },
            }
          : {}),
        accessToken: security.accessToken,
        limiter: limiterFor(security.limits),
        privilegedWorld: () => freshWorld(clock),
        clock,
        log: (entry) => console.log("[jarvis] case:", JSON.stringify({ deployment, ...entry })),
      },
    );
    return json(r.status, r.body, { ...r.headers, ...runtimeHeader });
  }

  let providerCheck: { at: number; result: Promise<ProviderCheck> } | null = null;

  async function health(request: Request): Promise<Response> {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    const mode = configuredMode(env);
    const real = realModelEnabled(env);
    const misconfigured = mode !== "fixture" && !real;
    let provider: ProviderCheck | null = null;
    if (real) {
      if (!providerCheck || Date.now() - providerCheck.at > PROVIDER_CHECK_TTL_MS) {
        providerCheck = { at: Date.now(), result: checkProvider(env) };
      }
      provider = await providerCheck.result;
    }
    return json(200, {
      ok: !misconfigured && (!real || (provider?.reachable === true && provider.modelListed === true)),
      service: "jarvis",
      deployment,
      aiMode: real ? "vllm" : "fixture",
      model: real ? (env.JARVIS_MODEL_NAME?.trim() ?? null) : null,
      remoteModel: real,
      // Health and cases are separate serverless functions/instances: this is health's own
      // GET /models check (cached 60 s), not the cases function's startup probe result.
      provider,
      data: "synthetic",
      paymentGateway: "simulated",
      freeText: env.JARVIS_CASES_TOKEN?.trim() ? "token required" : "disabled",
      limits: "per serverless instance, not global",
      note: misconfigured
        ? "Misconfigured: JARVIS_AI_MODE is not fixture but JARVIS_SERVERLESS_REAL_MODEL is not enabled, so cases are refused."
        : real
          ? "Real-model mode: an OpenAI-compatible endpoint answers model calls. This does not by itself prove the hardware it runs on."
          : "Public serverless demo: fixture AI only.",
    });
  }

  /** Read-only seeded demo store (synthetic orders and charges; no writes, no credentials). */
  function demoStore(request: Request): Response {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    return json(200, demoStoreSnapshot(() => new Date()));
  }

  return { cases, health, demoStore };
}
