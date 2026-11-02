// Generic OpenAI-compatible chat completions client (native fetch).
// No JARVIS prompts, schema mapping, or decision/understanding logic.

import {
  categorizeHttpStatus,
  ProviderError,
  redactSecrets,
} from "./errors.ts";

export interface OpenAICompatibleClientOptions {
  /** OpenAI-compatible API root, e.g. http://host:8000/v1 */
  baseUrl: string;
  model: string;
  /** Optional bearer token. Never logged or included in error messages. */
  apiKey?: string;
  timeoutMs: number;
  /** Reject response bodies larger than this. Default 1 MiB. */
  maxResponseBytes?: number;
  /**
   * Extra attempts after a transient failure (connection error, HTTP 429/500/502/503/504).
   * 0..3, default 0. Never retries other 4xx, timeouts, or unusable output.
   */
  maxRetries?: number;
  /** First backoff delay; doubles per attempt. Default 400 ms. */
  retryBaseDelayMs?: number;
  /** Cap on any single backoff, including a server's Retry-After. Default 4000 ms. */
  retryMaxDelayMs?: number;
  /**
   * Minimum spacing between request starts from this client (client-side rate limit for hosted
   * gateways with per-minute caps). 0 (default) disables it. Waiting counts against the caller's signal.
   */
  minIntervalMs?: number;
  /** Share one pacing gate between clients (e.g. two models on one account). Overrides minIntervalMs. */
  pacer?: RequestPacer;
}

/** Spaces request starts by a minimum interval, in call order. One instance can serve several clients. */
export class RequestPacer {
  readonly minIntervalMs: number;
  #nextStartAt = 0;

  constructor(minIntervalMs: number) {
    if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) {
      throw new ProviderError({ category: "CONFIG_ERROR", message: "minIntervalMs must be a non-negative integer" });
    }
    this.minIntervalMs = minIntervalMs;
  }

  // Reserve the next slot, then wait for it. Waiting counts against the caller's signal.
  async wait(signal?: AbortSignal): Promise<void> {
    if (this.minIntervalMs === 0) return;
    const now = Date.now();
    const startAt = Math.max(now, this.#nextStartAt);
    this.#nextStartAt = startAt + this.minIntervalMs;
    if (startAt > now) await sleep(startAt - now, signal);
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | string;
  content: string;
}

export interface ChatCompletionParams {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Extra OpenAI-compatible body fields (generic only; caller-owned). */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  /** Raw choices[0].message.content string from the provider. */
  content: string;
  /** Provider model id echoed in the response, if present. */
  model?: string;
  /** Provider response id, if present. */
  id?: string;
  /** choices[0].finish_reason, if present. Anything other than "stop" is rejected. */
  finishReason?: string;
  /** Token usage, if the provider reports it. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** HTTP attempts made (1 unless a transient error was retried). */
  attempts: number;
}

/** What a model adapter needs from a client (lets callers wrap one, e.g. for call logging). */
export interface ChatClient {
  readonly model: string;
  chatCompletions(params: ChatCompletionParams): Promise<ChatCompletionResult>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Retry-After per failed response; only read by the retry loop below.
const retryAfterMs = new WeakMap<ProviderError, number>();

export class OpenAICompatibleClient {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #pacer: RequestPacer;

  constructor(opts: OpenAICompatibleClientOptions) {
    if (!opts.baseUrl?.trim()) {
      throw new ProviderError({ category: "CONFIG_ERROR", message: "baseUrl is required" });
    }
    if (!opts.model?.trim()) {
      throw new ProviderError({ category: "CONFIG_ERROR", message: "model is required" });
    }
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
      throw new ProviderError({ category: "CONFIG_ERROR", message: "timeoutMs must be a positive number" });
    }
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#timeoutMs = opts.timeoutMs;
    this.#maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const retries = opts.maxRetries ?? 0;
    if (!Number.isInteger(retries) || retries < 0 || retries > 3) {
      throw new ProviderError({ category: "CONFIG_ERROR", message: "maxRetries must be an integer 0..3" });
    }
    this.#maxRetries = retries;
    this.#retryBaseDelayMs = opts.retryBaseDelayMs ?? 400;
    this.#retryMaxDelayMs = opts.retryMaxDelayMs ?? 4000;
    this.#pacer = opts.pacer ?? new RequestPacer(opts.minIntervalMs ?? 0);
  }

  get maxRetries(): number {
    return this.#maxRetries;
  }

  get model(): string {
    return this.#model;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async chatCompletions(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    if (!params.messages?.length) {
      throw new ProviderError({ category: "CONFIG_ERROR", message: "messages must be a non-empty array" });
    }

    const body: Record<string, unknown> = {
      model: this.#model,
      messages: params.messages,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      ...(params.extra ?? {}),
    };
    const { json, attempts } = await this.#withRetries(() => this.#requestJson("POST", "/chat/completions", body, params.signal), params.signal);
    return { ...extractChatCompletion(json), attempts };
  }

  /** GET {baseUrl}/models: ids of the models the server is serving (startup / health checks). */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const { json } = await this.#withRetries(() => this.#requestJson("GET", "/models", undefined, signal), signal);
    return extractModelIds(json);
  }

  // Bounded retry for transient failures only. Each attempt keeps its own timeout; the
  // caller's signal (the engine's case timer) still bounds the whole call, including backoff.
  async #withRetries(attempt: () => Promise<unknown>, signal?: AbortSignal): Promise<{ json: unknown; attempts: number }> {
    for (let n = 0; ; n++) {
      try {
        await this.#pacer.wait(signal);
        return { json: await attempt(), attempts: n + 1 };
      } catch (e) {
        const transient =
          e instanceof ProviderError &&
          (e.category === "CONNECTION_ERROR" || (e.statusCode !== undefined && RETRYABLE_STATUS.has(e.statusCode)));
        if (!transient || n >= this.#maxRetries) throw e;
        const hinted = retryAfterMs.get(e);
        const delay = Math.min(hinted ?? this.#retryBaseDelayMs * 2 ** n, this.#retryMaxDelayMs);
        await sleep(delay, signal);
      }
    }
  }

  // Shared transport: bearer auth, timeout + caller signal, bounded body, typed errors.
  async #requestJson(method: "GET" | "POST", path: string, body: unknown, callerSignal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.#apiKey) {
      headers.authorization = `Bearer ${this.#apiKey}`;
    }

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (err) {
      throw mapFetchError(err);
    }

    let rawText: string;
    try {
      rawText = await readBodyLimited(res, this.#maxResponseBytes);
    } catch (err) {
      // A timeout or abort while reading the body must surface as a ProviderError too.
      throw mapFetchError(err);
    }

    if (!res.ok) {
      const category = categorizeHttpStatus(res.status);
      const snippet = redactSecrets(rawText.replace(/\s+/g, " ").trim().slice(0, 200));
      const err = new ProviderError({
        category,
        statusCode: res.status,
        message: `provider HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
      });
      const hint = parseRetryAfter(res.headers.get("retry-after"));
      if (hint !== null) retryAfterMs.set(err, hint);
      throw err;
    }

    try {
      return JSON.parse(rawText) as unknown;
    } catch (err) {
      throw new ProviderError({
        category: "INVALID_JSON",
        message: `provider response is not JSON: ${(err as Error).message}`,
        cause: err,
      });
    }
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// Backoff that ends early (as a TIMEOUT ProviderError) if the caller aborts.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new ProviderError({ category: "TIMEOUT", message: "provider request aborted during retry backoff" }));
    };
    if (signal?.aborted) return abort();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) {
      parts.push(cur.name, cur.message);
      if ("code" in cur && cur.code != null) parts.push(String(cur.code));
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" ");
}

function mapFetchError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  const message = err instanceof Error ? err.message : String(err);
  const chain = errorChainText(err);
  const safe = redactSecrets(message);

  if (name === "TimeoutError" || name === "AbortError" || /aborted|timeout/i.test(chain)) {
    if (name === "TimeoutError" || /timeout/i.test(chain)) {
      return new ProviderError({ category: "TIMEOUT", message: "provider request timed out", cause: err });
    }
    return new ProviderError({ category: "TIMEOUT", message: "provider request aborted", cause: err });
  }

  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|fetch failed|network/i.test(chain)) {
    return new ProviderError({
      category: "CONNECTION_ERROR",
      message: `provider connection failed: ${safe}`,
      cause: err,
    });
  }

  return new ProviderError({
    category: "UNKNOWN_PROVIDER_ERROR",
    message: `provider request failed: ${safe}`,
    cause: err,
  });
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  const lenHeader = res.headers.get("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ProviderError({
        category: "RESPONSE_TOO_LARGE",
        message: `provider response exceeds ${maxBytes} bytes (Content-Length ${declared})`,
      });
    }
  }

  // Stream so we can abort oversized bodies without Content-Length.
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ProviderError({
        category: "RESPONSE_TOO_LARGE",
        message: `provider response exceeds ${maxBytes} bytes`,
      });
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new ProviderError({
        category: "RESPONSE_TOO_LARGE",
        message: `provider response exceeds ${maxBytes} bytes`,
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractChatCompletion(json: unknown): Omit<ChatCompletionResult, "attempts"> {
  if (!json || typeof json !== "object") {
    throw new ProviderError({
      category: "INVALID_PROVIDER_RESPONSE",
      message: "provider response is not an object",
    });
  }
  const obj = json as Record<string, unknown>;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError({
      category: "INVALID_PROVIDER_RESPONSE",
      message: "provider response missing choices[0]",
    });
  }
  const first = choices[0];
  if (!first || typeof first !== "object") {
    throw new ProviderError({
      category: "INVALID_PROVIDER_RESPONSE",
      message: "provider response choices[0] is not an object",
    });
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") {
    throw new ProviderError({
      category: "INVALID_PROVIDER_RESPONSE",
      message: "provider response missing choices[0].message",
    });
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string") {
    throw new ProviderError({
      category: "INVALID_PROVIDER_RESPONSE",
      message: "provider response choices[0].message.content is not a string",
    });
  }
  // Truncated, filtered or tool-call output is not a usable answer, even if the
  // partial content happens to parse.
  const finishReason = (first as Record<string, unknown>).finish_reason;
  if (finishReason != null && finishReason !== "stop") {
    throw new ProviderError({
      category: "INVALID_PROVIDER_RESPONSE",
      message: `provider output unusable (truncated or filtered): finish_reason=${String(finishReason)}`,
    });
  }
  return {
    content,
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    ...(typeof obj.id === "string" ? { id: obj.id } : {}),
    ...(typeof finishReason === "string" ? { finishReason } : {}),
    ...extractUsage(obj.usage),
  };
}

function extractModelIds(json: unknown): string[] {
  const data = json && typeof json === "object" ? (json as Record<string, unknown>).data : undefined;
  if (!Array.isArray(data)) {
    throw new ProviderError({ category: "INVALID_PROVIDER_RESPONSE", message: "models response missing data[]" });
  }
  return data.map((m, i) => {
    const id = m && typeof m === "object" ? (m as Record<string, unknown>).id : undefined;
    if (typeof id !== "string" || !id) {
      throw new ProviderError({ category: "INVALID_PROVIDER_RESPONSE", message: `models response data[${i}].id is not a string` });
    }
    return id;
  });
}

function extractUsage(raw: unknown): Pick<ChatCompletionResult, "usage"> {
  if (!raw || typeof raw !== "object") return {};
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const usage = {
    ...(num(u.prompt_tokens) !== undefined ? { promptTokens: num(u.prompt_tokens) } : {}),
    ...(num(u.completion_tokens) !== undefined ? { completionTokens: num(u.completion_tokens) } : {}),
    ...(num(u.total_tokens) !== undefined ? { totalTokens: num(u.total_tokens) } : {}),
  };
  return Object.keys(usage).length > 0 ? { usage } : {};
}
