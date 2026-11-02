// Scoped context: each specialist receives only the metrics and tools its role permits.
import { agentById, type AgentId, type TeamTool } from "./agents.ts";
import { DATASET_META } from "./dataset.ts";
import { computeMetrics, marginBridge, supportCapacity, type Metric, type MetricKey } from "./metrics.ts";

export interface SharedNote {
  from: AgentId;
  messageId: string;
  text: string;
}

export interface ScopedContext {
  dataset: string;
  metrics: Partial<Record<MetricKey, Metric>>;
  tools: Partial<{ margin_bridge: ReturnType<typeof marginBridge>; support_capacity: ReturnType<typeof supportCapacity> }>;
  /** Owner-shared excerpts from private chats. Only what the owner explicitly shared. */
  shared: SharedNote[];
}

export function scopedContext(agent: AgentId, shared: SharedNote[] = []): ScopedContext {
  const role = agentById(agent);
  const all = computeMetrics();
  const metrics: ScopedContext["metrics"] = {};
  for (const k of role.metrics) metrics[k] = all[k];
  const tools: ScopedContext["tools"] = {};
  const allowed = (t: TeamTool) => role.tools.includes(t);
  if (allowed("margin_bridge")) tools.margin_bridge = marginBridge();
  if (allowed("support_capacity")) tools.support_capacity = supportCapacity();
  return { dataset: DATASET_META.id, metrics, tools, shared };
}
