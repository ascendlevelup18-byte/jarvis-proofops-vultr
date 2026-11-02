// Private specialist chats for ONE local user (this browser). Not multi-user, not encrypted, not synced.
// Each agent has its own thread; nothing leaves a thread unless the owner shares that specific message.
import type { AgentId } from "./agents.ts";
import type { SharedNote } from "./context.ts";

export interface ChatMessage {
  id: string;
  seq: number; // order within the thread
  author: "owner" | AgentId;
  authorKind: "human" | "ai-fixture" | "ai-live";
  /** Which provider produced an AI message, e.g. "OPENROUTER LIVE INFERENCE · vendor/model". */
  provenance?: string;
  text: string;
  at: string;
  evidence?: string[];
  sharedToBoardroom?: boolean;
}

export interface TeamStore {
  version: 1;
  owner: "local-owner";
  threads: Partial<Record<AgentId, ChatMessage[]>>;
}

export const STORE_KEY = "jarvis.team.v1";
/** Messages kept per thread; older ones are dropped (and say so in the UI). */
export const MAX_THREAD = 60;
export const MAX_MESSAGE_CHARS = 1200;

export const emptyStore = (): TeamStore => ({ version: 1, owner: "local-owner", threads: {} });

export function thread(store: TeamStore, agent: AgentId): ChatMessage[] {
  return store.threads[agent] ?? [];
}

export function append(store: TeamStore, agent: AgentId, msg: Omit<ChatMessage, "id" | "seq">): TeamStore {
  const prev = thread(store, agent);
  const seq = (prev[prev.length - 1]?.seq ?? 0) + 1;
  const next: ChatMessage = { ...msg, text: msg.text.slice(0, MAX_MESSAGE_CHARS), seq, id: `${agent}-${seq}` };
  return { ...store, threads: { ...store.threads, [agent]: [...prev, next].slice(-MAX_THREAD) } };
}

export function setShared(store: TeamStore, agent: AgentId, messageId: string, shared: boolean): TeamStore {
  return { ...store, threads: { ...store.threads, [agent]: thread(store, agent).map((m) => (m.id === messageId ? { ...m, sharedToBoardroom: shared } : m)) } };
}

/** The only path from private chats into the boardroom: messages the owner explicitly marked as shared. */
export function sharedNotes(store: TeamStore): SharedNote[] {
  return (Object.entries(store.threads) as [AgentId, ChatMessage[]][]).flatMap(([agent, msgs]) =>
    msgs.filter((m) => m.sharedToBoardroom).map((m) => ({ from: agent, messageId: m.id, text: m.text })),
  );
}

export function deleteThread(store: TeamStore, agent: AgentId): TeamStore {
  const threads = { ...store.threads };
  delete threads[agent];
  return { ...store, threads };
}

export function exportThread(store: TeamStore, agent: AgentId): string {
  return JSON.stringify({ exported: "JARVIS AI Team private chat", agent, scope: "single local user, synthetic data, fixture specialists", messages: thread(store, agent) }, null, 2);
}

/** Parses saved state defensively; anything unexpected becomes an empty store rather than a crash. */
export function parseStore(raw: string | null): TeamStore {
  if (!raw) return emptyStore();
  try {
    const v = JSON.parse(raw);
    if (v?.version !== 1 || typeof v.threads !== "object" || v.threads === null) return emptyStore();
    const threads: TeamStore["threads"] = {};
    for (const [k, msgs] of Object.entries(v.threads)) {
      if (!["ceo", "cfo", "sales", "cmo", "coo", "hr"].includes(k) || !Array.isArray(msgs)) continue;
      threads[k as AgentId] = (msgs as ChatMessage[])
        .filter((m) => m && typeof m.text === "string" && typeof m.seq === "number" && (m.author === "owner" || m.author === k))
        .sort((a, b) => a.seq - b.seq)
        .slice(-MAX_THREAD);
    }
    return { version: 1, owner: "local-owner", threads };
  } catch {
    return emptyStore();
  }
}

export function loadStore(): TeamStore {
  try {
    return parseStore(localStorage.getItem(STORE_KEY));
  } catch {
    return emptyStore();
  }
}

export function saveStore(store: TeamStore): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable: the session still works in memory */
  }
}
