// Generic response cleanup for OpenAI-compatible model outputs.
// Strips code fences and optional reasoning blocks only.
// Does NOT interpret JARVIS schemas, intents, or decision proposals.

export interface CleanupOptions {
  /** Strip <think>...</think> / <reasoning>...</reasoning> style blocks. Default true. */
  stripReasoningBlocks?: boolean;
}

/**
 * Normalize a model content string for downstream JSON parsing.
 * - Optionally removes reasoning/think blocks
 * - Strips a single surrounding markdown code fence (``` or ```json)
 * - Does not parse JSON or validate any domain schema
 */
export function cleanupModelContent(raw: string, opts: CleanupOptions = {}): string {
  const stripReasoning = opts.stripReasoningBlocks !== false;
  let text = raw;

  if (stripReasoning) {
    text = text
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
      .replace(/<reason>[\s\S]*?<\/reason>/gi, "");
  }

  text = text.trim();

  const fence = /^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/.exec(text);
  if (fence?.[1] !== undefined) {
    text = fence[1].trim();
  }

  return text;
}
