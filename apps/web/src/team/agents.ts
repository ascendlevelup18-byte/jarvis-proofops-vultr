// Versioned role definitions for the AI Executive Team. Each role sees only its permitted metrics and may
// use only its permitted tools. No role has a tool that changes money, prices, staff or customer data.
import { z } from "zod";
import type { MetricKey } from "./metrics.ts";

export type AgentId = "ceo" | "cfo" | "sales" | "cmo" | "coo" | "hr";

/** Read-only analysis tools. Anything else a specialist asks for is refused and audited. */
export const TEAM_TOOLS = ["read_metrics", "margin_bridge", "support_capacity"] as const;
export type TeamTool = (typeof TEAM_TOOLS)[number];

export interface AgentRole {
  id: AgentId;
  version: string;
  title: string;
  short: string;
  responsibilities: string[];
  /** Topics this role is selected for in the boardroom. */
  topics: Topic[];
  metrics: MetricKey[];
  tools: TeamTool[];
  boundary: string;
}

export type Topic = "sales" | "margin" | "quality" | "marketing" | "staffing" | "strategy";

export const AGENTS: AgentRole[] = [
  {
    id: "ceo", version: "ceo@1.0.0", title: "CEO · Strategy", short: "CEO",
    responsibilities: ["Company priorities", "Strategic trade-offs", "Decision consolidation", "Coordination between specialists"],
    topics: ["strategy"], metrics: ["netRevenue", "grossMarginPct", "csatPct", "orders"], tools: ["read_metrics"],
    boundary: "Summarizes and orders the team's proposals. Cannot override policy controls or decide for the owner.",
  },
  {
    id: "cfo", version: "cfo@1.0.0", title: "CFO · Finance", short: "CFO",
    responsibilities: ["Revenue and cost assumptions", "Unit economics", "Gross margin", "Budget scenarios", "Profit improvement"],
    topics: ["margin", "sales", "marketing"], metrics: ["netRevenue", "grossMarginPct", "refundCostSharePct", "cacUsd", "marketingSpendUsd"], tools: ["read_metrics", "margin_bridge"],
    boundary: "Every figure comes from the deterministic calculations; forecasts are labelled as scenarios.",
  },
  {
    id: "sales", version: "sales@1.0.0", title: "Sales Director", short: "Sales",
    responsibilities: ["Conversion", "Funnel diagnosis", "Repeat revenue", "Revenue improvement"],
    topics: ["sales"], metrics: ["orders", "conversionPct", "repeatOrderSharePct", "netRevenue"], tools: ["read_metrics"],
    boundary: "Names the metric that would confirm or refute each recommendation.",
  },
  {
    id: "cmo", version: "cmo@1.0.0", title: "CMO · Marketing", short: "CMO",
    responsibilities: ["Acquisition cost", "Retention", "Segmentation", "Experiment planning"],
    topics: ["marketing", "sales"], metrics: ["marketingSpendUsd", "cacUsd", "repeatOrderSharePct", "conversionPct", "csatPct"], tools: ["read_metrics"],
    boundary: "Campaign outcomes are hypotheses until an experiment measures them.",
  },
  {
    id: "coo", version: "coo@1.0.0", title: "COO · Operations", short: "COO",
    responsibilities: ["Fulfilment quality", "Support operations", "Error reduction", "Controlled automation"],
    topics: ["quality", "staffing"], metrics: ["refundRatePct", "defectReturnSharePct", "lateShipmentPct", "firstResponseHours", "csatPct"], tools: ["read_metrics", "support_capacity"],
    boundary: "May propose automations only with the JARVIS pattern: AI proposes, policy decides, results are verified.",
  },
  {
    id: "hr", version: "hr@1.0.0", title: "HR Director · People", short: "HR",
    responsibilities: ["Workforce capacity", "Hiring scenarios", "Training", "Team effectiveness"],
    topics: ["staffing", "quality"], metrics: ["ticketsPerAgent", "firstResponseHours", "supportFte"], tools: ["read_metrics", "support_capacity"],
    boundary: "Proposes capacity and training options only. Never makes employment decisions or infers personal characteristics.",
  },
];

export const agentById = (id: AgentId) => AGENTS.find((a) => a.id === id)!;

/** Structured output every specialist must return; anything else is rejected before it reaches the plan. */
export const SpecialistOutput = z.object({
  agent: z.enum(["ceo", "cfo", "sales", "cmo", "coo", "hr"]),
  roleVersion: z.string(),
  findings: z
    .array(z.object({ text: z.string().min(1).max(400), kind: z.enum(["measured", "hypothesis"]), evidence: z.array(z.string()).min(1) }).strict())
    .min(1)
    .max(6),
  recommendations: z
    .array(
      z.object({
        id: z.string(),
        action: z.string().min(1).max(300),
        lever: z.string(),
        direction: z.enum(["increase", "decrease", "investigate", "maintain"]),
        successMetric: z.string(),
        owner: z.enum(["ceo", "cfo", "sales", "cmo", "coo", "hr"]),
        requiresApproval: z.literal(true),
        tool: z.string().optional(),
      }).strict(), // unknown keys such as "status": "approved" are rejected, not ignored
    )
    .max(4),
  missingInformation: z.array(z.string()).max(5),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutput>;
