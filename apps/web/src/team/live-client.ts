// Browser client for the operator-only live AI Team on the local JARVIS server. The browser never holds a
// provider key: it sends only the server's operator token, kept in page memory for this session.
import type { AgentId } from "./agents.ts";
import type { SharedNote } from "./context.ts";
import type { BoardroomResult } from "./orchestrator.ts";
import type { ProviderInfo } from "./provider.ts";

export interface LiveUsage {
  calls: number;
  maxRequests?: number;
  remainingRequests?: number;
  costUnreported?: number;
  freeOnly?: boolean;
  stopped?: string | null;
  spentUsd: number;
  capUsd: number;
  tokens: { prompt: number; completion: number };
  scope: string;
}

export class LiveTeamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MESSAGES: Record<number, string> = {
  401: "The operator token was not accepted.",
  403: "This server has no operator token configured, so the live team is off.",
  404: "The live team is not enabled on this server (fixture only).",
  413: "The request is too large.",
  429: "The team is already working on a request. Try again shortly.",
  502: "The model provider failed; nothing was used.",
};

async function call<T>(path: string, token: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw new LiveTeamError(res.status, MESSAGES[res.status] ?? `Server answered HTTP ${res.status}.`);
  return (await res.json()) as T;
}

export const liveStatus = (token: string) => call<{ provider: ProviderInfo; usage: LiveUsage }>("/team/status", token);
export const liveBoardroom = (token: string, request: string, shared: SharedNote[], signal?: AbortSignal) =>
  call<BoardroomResult & { usage: LiveUsage }>("/team/boardroom", token, { request, shared }, signal);
export const liveReply = (token: string, agent: AgentId, question: string) =>
  call<{ text: string; evidence: string[]; provider: ProviderInfo; usage: LiveUsage }>("/team/reply", token, { agent, question });

/** Provenance label shown next to every AI Team output. */
export function provenanceLabel(p: ProviderInfo): string {
  return p.kind === "live" ? `OPENROUTER LIVE INFERENCE · ${p.model}` : "DETERMINISTIC FIXTURE · no language model";
}
