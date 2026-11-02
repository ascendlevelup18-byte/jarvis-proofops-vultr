// Typed provider errors for the generic OpenAI-compatible HTTP client.
// Never include API keys or Authorization headers in messages or details.

export const PROVIDER_ERROR_CATEGORIES = [
  "CONFIG_ERROR",
  "CONNECTION_ERROR",
  "TIMEOUT",
  "HTTP_4XX",
  "HTTP_5XX",
  "INVALID_JSON",
  "INVALID_PROVIDER_RESPONSE",
  "RESPONSE_TOO_LARGE",
  "UNKNOWN_PROVIDER_ERROR",
] as const;

export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

export interface ProviderErrorOptions {
  category: ProviderErrorCategory;
  message: string;
  statusCode?: number;
  cause?: unknown;
}

/** Strip anything that looks like a bearer token or api_key value from a string. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s&,}]+/gi, "$1[REDACTED]")
    .replace(/(authorization["']?\s*[:=]\s*["']?)[^"'\s&,}]+/gi, "$1[REDACTED]");
}

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly statusCode: number | undefined;

  constructor(opts: ProviderErrorOptions) {
    super(redactSecrets(opts.message));
    this.name = "ProviderError";
    this.category = opts.category;
    this.statusCode = opts.statusCode;
    if (opts.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }

  /** Safe for logs: category + message only; never serializes secrets. */
  toJSON(): { name: string; category: ProviderErrorCategory; message: string; statusCode?: number } {
    return {
      name: this.name,
      category: this.category,
      message: this.message,
      ...(this.statusCode !== undefined ? { statusCode: this.statusCode } : {}),
    };
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

export function categorizeHttpStatus(status: number): "HTTP_4XX" | "HTTP_5XX" | "UNKNOWN_PROVIDER_ERROR" {
  if (status >= 400 && status < 500) return "HTTP_4XX";
  if (status >= 500 && status < 600) return "HTTP_5XX";
  return "UNKNOWN_PROVIDER_ERROR";
}
