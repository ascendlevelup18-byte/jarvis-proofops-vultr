// Provider boundary for the AI Team. The orchestrator only ever calls TeamProvider; which backend answers is
// explicit and reported with every response.
//
// Implemented now: FixtureTeamProvider, deterministic rules over the synthetic dataset. It is NOT a language model
// and every answer it produces is labelled "fixture".
//
// Designed, not connected: an OpenAI-compatible adapter (AMD-hosted inference, a local server, or another cloud
// provider) must run SERVER-SIDE, read its key from server environment variables, send each specialist only its
// scoped context with the SpecialistOutput JSON schema, and return the raw text for the orchestrator to validate.
// No key is ever placed in this browser bundle, and the historical AMD key must not be reused.
import type { AgentId } from "./agents.ts";
import type { ScopedContext } from "./context.ts";
import { withholdUnsupported } from "./figures.ts";
import { fixtureAnalysis, fixtureReply } from "./specialists.ts";

export interface ProviderInfo {
  kind: "fixture" | "live";
  name: string;
  model: string | null;
}

export interface ProviderResult {
  /** Raw output; the orchestrator validates it against SpecialistOutput before use. */
  output: unknown;
  provider: ProviderInfo;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

export interface TeamProvider {
  readonly info: ProviderInfo;
  analyze(agent: AgentId, task: string, context: ScopedContext, signal: AbortSignal): Promise<ProviderResult>;
  reply(agent: AgentId, question: string, context: ScopedContext, signal: AbortSignal): Promise<{ text: string; evidence: string[]; provider: ProviderInfo }>;
}

export const FIXTURE_PROVIDER_INFO: ProviderInfo = { kind: "fixture", name: "JARVIS fixture specialists (deterministic rules)", model: null };

export class FixtureTeamProvider implements TeamProvider {
  readonly info = FIXTURE_PROVIDER_INFO;
  private readonly delayMs: number;
  /** delayMs paces the fixture so the UI's progress states are visible; it is not model latency. */
  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }

  private async wait(signal: AbortSignal) {
    if (this.delayMs === 0) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.delayMs);
      signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason ?? new Error("aborted"))), { once: true });
    });
  }

  async analyze(agent: AgentId, task: string, context: ScopedContext, signal: AbortSignal): Promise<ProviderResult> {
    const t0 = Date.now();
    await this.wait(signal);
    return { output: fixtureAnalysis(agent, task, context), provider: this.info, latencyMs: Date.now() - t0, tokensIn: null, tokensOut: null, costUsd: null };
  }

  async reply(agent: AgentId, question: string, context: ScopedContext, signal: AbortSignal) {
    await this.wait(signal);
    const r = fixtureReply(agent, question, context);
    // Same figure rule as live replies and the boardroom.
    return { ...r, text: withholdUnsupported(r.text, context).text, provider: this.info };
  }
}
