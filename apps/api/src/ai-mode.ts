// AI mode composition and fail-closed startup.
// fixture: deterministic fixture adapters, no endpoint, no network.
// vllm: OpenAI-compatible clients behind the two vLLM adapters: one model for both stages, or a
// separate understanding model (JARVIS_UNDERSTANDING_MODEL_NAME) on the same endpoint, sharing one
// request pacer. Before the app accepts cases, the endpoint must list every configured model and
// answer one synthetic probe per adapter with output the engine's strict parsers accept.
// vllm never falls back to fixture: any failure here stops startup.

import { resolveModelTimeouts, sanitizeEndpoint, type AiConfig, type AiMode, type StructuredOutputMode } from "./ai-config.ts";
import type { EvidenceBundle } from "./contracts.ts";
import { REFUND_POLICY } from "./fixtures.ts";
import {
  buildModelInput,
  decisionPromptVersion,
  FixtureModelAdapter,
  parseProposal,
  VllmModelAdapter,
  type ModelAdapter,
} from "./model-adapter.ts";
import {
  isProviderError,
  OpenAICompatibleClient,
  ProviderError,
  RequestPacer,
  type ChatClient,
  type ChatCompletionParams,
  type ChatCompletionResult,
} from "./provider/index.ts";
import {
  FixtureRequestUnderstandingAdapter,
  parseStructuredRequest,
  UNDERSTANDING_PROMPT_VERSION,
  VllmRequestUnderstandingAdapter,
  type RequestUnderstandingAdapter,
} from "./request-understanding.ts";

export interface AiRuntime {
  mode: AiMode;
  understanding: RequestUnderstandingAdapter;
  model: ModelAdapter;
  engineTimeoutMs: number;
  /** Worst-case provider calls per case, for budget reservation (2 stages × attempts). */
  modelCallsPerCase: number;
}

/** One line per provider call: operational metadata only, never prompts, customer text or keys. */
export interface ModelCallLog {
  stage: "UNDERSTANDING" | "MODEL";
  model: string;
  responseId: string | null;
  finishReason: string | null;
  latencyMs: number;
  /** HTTP attempts (more than 1 only when a transient error was retried). */
  attempts: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  failureCategory: string | null;
  /** Model id the provider says served the call (null when the response omits it). */
  servedModel: string | null;
}

/**
 * Does the provider's reported model match the configured one? Hosted gateways may prefix the id
 * (e.g. "self-dploy/DeepSeek-V4-Flash" for "DeepSeek-V4-Flash"). null when the provider did not say.
 */
export function servedModelMatches(configured: string, served: string | null | undefined): boolean | null {
  if (served === null || served === undefined || served === "") return null;
  return served === configured || served.endsWith(`/${configured}`);
}

export interface AiStartupReport {
  mode: AiMode;
  /** Decision-stage model. */
  model: string | null;
  /** Understanding-stage model (equals model unless configured separately). */
  understandingModel: string | null;
  endpoint: string | null;
  structuredOutput: StructuredOutputMode | null;
  understandingStructuredOutput: StructuredOutputMode | null;
  maxRetries: number | null;
  /** null in fixture mode (no endpoint to check). */
  modelListed: boolean | null;
  probes: { understanding: "ok"; decision: "ok" } | null;
  promptVersions: { understanding: string; decision: string };
  startupMs: number;
}

export type AiStartupStage = "MODEL_LIST" | "MODEL_NOT_SERVED" | "PROBE_UNDERSTANDING" | "PROBE_DECISION";

export class AiStartupError extends Error {
  readonly stage: AiStartupStage;
  constructor(stage: AiStartupStage, message: string) {
    super(`${stage}: ${message}`);
    this.name = "AiStartupError";
    this.stage = stage;
  }
}

export interface AiInitOptions {
  onCall?: (entry: ModelCallLog) => void;
  /** Optional outer wrapper per stage (the cloud gateway reserves durable quota before every model request). */
  wrapClient?: (client: ChatClient, stage: ModelCallLog["stage"]) => ChatClient;
}

/** Builds the adapters for the configured mode. No network. vllm never builds fixture adapters. */
export function buildAiAdapters(
  config: AiConfig,
  opts: AiInitOptions = {},
): AiRuntime & { client: OpenAICompatibleClient | null; understandingClient: OpenAICompatibleClient | null } {
  const timeouts = resolveModelTimeouts(config);
  if (config.mode === "fixture") {
    return {
      mode: "fixture",
      understanding: new FixtureRequestUnderstandingAdapter(),
      model: new FixtureModelAdapter(),
      engineTimeoutMs: timeouts.engineTimeoutMs,
      modelCallsPerCase: 0,
      client: null,
      understandingClient: null,
    };
  }
  // loadAiConfig guarantees these for vllm; re-checked so a hand-built config cannot slip through.
  if (!config.modelBaseUrl || !config.modelName || timeouts.clientTimeoutMs === null) {
    throw new Error("vllm mode requires modelBaseUrl and modelName");
  }
  // One pacer for every client: the account's rate limit covers both models.
  const pacer = new RequestPacer(config.modelMinIntervalMs);
  const clientFor = (model: string) =>
    new OpenAICompatibleClient({
      baseUrl: config.modelBaseUrl!,
      model,
      ...(config.modelApiKey ? { apiKey: config.modelApiKey } : {}),
      timeoutMs: timeouts.clientTimeoutMs!,
      maxRetries: config.modelMaxRetries,
      pacer,
    });
  const client = clientFor(config.modelName);
  const understandingModel = config.understandingModelName ?? config.modelName;
  const understandingClient = understandingModel === config.modelName ? client : clientFor(understandingModel);
  return {
    mode: "vllm",
    understanding: new VllmRequestUnderstandingAdapter(wrapped(logged(understandingClient, "UNDERSTANDING", opts.onCall), "UNDERSTANDING", opts), {
      structuredOutput: config.understandingStructuredOutput,
    }),
    model: new VllmModelAdapter(wrapped(logged(client, "MODEL", opts.onCall), "MODEL", opts), { structuredOutput: config.structuredOutput }),
    engineTimeoutMs: timeouts.engineTimeoutMs,
    modelCallsPerCase: 2 * (1 + config.modelMaxRetries),
    client,
    understandingClient,
  };
}

/** Builds the runtime and, in vllm mode, proves the endpoint is usable before returning it. */
export async function initializeAi(config: AiConfig, opts: AiInitOptions = {}): Promise<{ runtime: AiRuntime; startup: AiStartupReport }> {
  const started = performance.now();
  const { client, understandingClient, ...runtime } = buildAiAdapters(config, opts);
  const promptVersions = { understanding: UNDERSTANDING_PROMPT_VERSION, decision: decisionPromptVersion(REFUND_POLICY.sections) };
  const report = (over: Partial<AiStartupReport>): AiStartupReport => ({
    mode: config.mode,
    model: null,
    understandingModel: null,
    endpoint: null,
    structuredOutput: null,
    understandingStructuredOutput: null,
    maxRetries: null,
    modelListed: null,
    probes: null,
    promptVersions,
    startupMs: Math.round(performance.now() - started),
    ...over,
  });
  if (client === null || understandingClient === null) return { runtime, startup: report({}) };

  const scrub = (msg: string) => (config.modelApiKey ? msg.split(config.modelApiKey).join("[REDACTED]") : msg);
  const fail = (stage: AiStartupStage, msg: string): never => {
    throw new AiStartupError(stage, scrub(msg));
  };
  const signal = () => AbortSignal.timeout(runtime.engineTimeoutMs);

  let served: string[] = [];
  try {
    served = await client.listModels(signal());
  } catch (e) {
    fail("MODEL_LIST", errorText(e));
  }
  for (const model of new Set([client.model, understandingClient.model])) {
    if (!served.includes(model)) {
      fail("MODEL_NOT_SERVED", `model ${JSON.stringify(model)} is not served by the endpoint (served: ${served.slice(0, 12).join(", ") || "none"})`);
    }
  }

  // Synthetic probes through the real adapters and the real strict parsers. No customer data.
  let raw = "";
  try {
    raw = await runtime.understanding.understand({ untrusted: { customerMessage: PROBE_MESSAGE } }, signal());
  } catch (e) {
    fail("PROBE_UNDERSTANDING", errorText(e));
  }
  const understood = parseStructuredRequest(raw);
  if (!understood.ok) fail("PROBE_UNDERSTANDING", `output does not match the schema: ${understood.error}`);

  try {
    raw = await runtime.model.propose(buildModelInput("PROBE", PROBE_MESSAGE, probeEvidence()), signal());
  } catch (e) {
    fail("PROBE_DECISION", errorText(e));
  }
  const proposed = parseProposal(raw);
  if (!proposed.ok) fail("PROBE_DECISION", `output does not match the schema: ${proposed.error}`);

  return {
    runtime,
    startup: report({
      model: client.model,
      understandingModel: understandingClient.model,
      endpoint: sanitizeEndpoint(client.baseUrl),
      structuredOutput: config.structuredOutput,
      understandingStructuredOutput: config.understandingStructuredOutput,
      maxRetries: config.modelMaxRetries,
      modelListed: true,
      probes: { understanding: "ok", decision: "ok" },
    }),
  };
}

function errorText(e: unknown): string {
  return isProviderError(e) ? `${e.category}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

// Wraps the client per stage: every provider call yields one safe log entry, and a reply the
// provider attributes to a different model is rejected, so audited attribution is never wrong.
const wrapped = (c: ChatClient, stage: ModelCallLog["stage"], opts: AiInitOptions) => (opts.wrapClient ? opts.wrapClient(c, stage) : c);

function logged(client: ChatClient, stage: ModelCallLog["stage"], onCall: AiInitOptions["onCall"]): ChatClient {
  return {
    model: client.model,
    async chatCompletions(params: ChatCompletionParams): Promise<ChatCompletionResult> {
      const started = performance.now();
      const entry = (r: ChatCompletionResult | null, failureCategory: string | null): ModelCallLog => ({
        stage,
        model: client.model,
        responseId: r?.id ?? null,
        finishReason: r?.finishReason ?? null,
        latencyMs: Math.round(performance.now() - started),
        attempts: r?.attempts ?? null,
        promptTokens: r?.usage?.promptTokens ?? null,
        completionTokens: r?.usage?.completionTokens ?? null,
        failureCategory,
        servedModel: r?.model ?? null,
      });
      let r: ChatCompletionResult;
      try {
        r = await client.chatCompletions(params);
      } catch (e) {
        onCall?.(entry(null, isProviderError(e) ? e.category : "UNKNOWN"));
        throw e;
      }
      if (servedModelMatches(client.model, r.model) === false) {
        onCall?.(entry(r, "MODEL_MISMATCH"));
        throw new ProviderError({
          category: "INVALID_PROVIDER_RESPONSE",
          message: `provider reported model ${JSON.stringify(r.model)} for a request to ${JSON.stringify(client.model)}`,
        });
      }
      onCall?.(entry(r, null));
      return r;
    },
  };
}

// ---------- synthetic probe case (no customer data; never stored or executed) ----------

const PROBE_MESSAGE = "I was charged twice for order #PROBE-1.";

function probeEvidence(): EvidenceBundle {
  const at = "2026-01-01T00:00:00.000Z";
  const charge = (id: string) => ({
    id,
    orderId: "PROBE-1",
    customerId: "PROBE-CUST",
    amountMinor: 1000,
    currency: "USD" as const,
    status: "SUCCEEDED" as const,
    refundedMinor: 0,
    createdAt: at,
  });
  return {
    customer: { id: "PROBE-CUST", name: "Probe" },
    order: { id: "PROBE-1", customerId: "PROBE-CUST", totalMinor: 1000, currency: "USD", createdAt: at },
    transactions: [charge("PROBE-CHARGE-A"), charge("PROBE-CHARGE-B")],
    refunds: [],
    policy: REFUND_POLICY,
    customerIntent: "DUPLICATE_CHARGE_REFUND",
    intentCues: { duplicateCharge: true, outOfScope: [] },
    duplicateGroups: [{ transactionIds: ["PROBE-CHARGE-A", "PROBE-CHARGE-B"], amountMinor: 1000, currency: "USD" }],
    financial: { netPaidMinor: 2000, orderTotalMinor: 1000, status: "OVERPAID" },
    mentionedAmounts: [],
    contradictions: [],
    sourceIds: ["PROBE-1", "PROBE-CHARGE-A", "PROBE-CHARGE-B", ...REFUND_POLICY.sections.map((s) => s.id)],
  };
}
