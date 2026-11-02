// Public surface for the generic OpenAI-compatible provider scaffold.
// Kickoff adapters must import from here — not invent a parallel client.

export {
  PROVIDER_ERROR_CATEGORIES,
  ProviderError,
  categorizeHttpStatus,
  isProviderError,
  redactSecrets,
  type ProviderErrorCategory,
  type ProviderErrorOptions,
} from "./errors.ts";

export { cleanupModelContent, type CleanupOptions } from "./response-cleanup.ts";

export {
  OpenAICompatibleClient,
  RequestPacer,
  type ChatCompletionParams,
  type ChatClient,
  type ChatCompletionResult,
  type ChatMessage,
  type OpenAICompatibleClientOptions,
} from "./openai-compatible-client.ts";
