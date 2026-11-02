// FIXTURE specialists: deterministic rules over each role's scoped metrics. Not a language model.
// They exist so the orchestration, schemas, budgets and UI can be built and tested without paid inference.
// Each rule reads only the metrics present in its ScopedContext; a missing metric means the rule stays silent.
import { agentById, type AgentId, type SpecialistOutput } from "./agents.ts";
import type { ScopedContext } from "./context.ts";
import { formatMetricValue, type Metric, type MetricKey } from "./metrics.ts";

type Finding = SpecialistOutput["findings"][number];

const ev = (m: Metric): string[] => [m.key, m.evidence[0]!, m.evidence[m.evidence.length - 1]!];
const fmt = (m: Metric, v: number) => formatMetricValue(m.unit, v);
const move = (m: Metric) => `${m.label} moved from ${fmt(m, m.first)} to ${fmt(m, m.last)}`;

function measured(ctx: ScopedContext, key: MetricKey, suffix = ""): Finding | null {
  const m = ctx.metrics[key];
  return m ? { text: `${move(m)} over six months${suffix}.`, kind: "measured", evidence: ev(m) } : null;
}

const compact = <T,>(xs: (T | null | undefined | false)[]) => xs.filter((x): x is T => Boolean(x));

export function fixtureAnalysis(agent: AgentId, _task: string, ctx: ScopedContext): SpecialistOutput {
  const roleVersion = agentById(agent).version;
  const bridge = ctx.tools.margin_bridge;
  const cap = ctx.tools.support_capacity;
  switch (agent) {
    case "cfo":
      return {
        agent, roleVersion,
        findings: compact<Finding>([
          measured(ctx, "grossMarginPct"),
          bridge && { text: `Holding the April refund share constant, refunds explain ${Math.abs(bridge.fromRefundsPts)} of the ${Math.abs(bridge.totalChangePts)} margin points lost; costs explain the other ${Math.abs(bridge.fromCostsPts)}. Excess refunds in September: about $${bridge.excessRefundsUsd.toLocaleString("en-US")}.`, kind: "measured" as const, evidence: ["margin_bridge", ...bridge.evidence] },
          measured(ctx, "cacUsd", " while spend rose"),
          { text: "Whether higher acquisition cost reflects channel saturation or weaker conversion after poor experiences cannot be separated from these records.", kind: "hypothesis", evidence: ["cacUsd", "marketingSpendUsd"] },
        ]),
        recommendations: [
          { id: "cfo-1", action: "Hold total marketing spend at the September level until an experiment shows which channels still return their cost.", lever: "marketingSpend", direction: "decrease", successMetric: "Marketing cost per new customer back toward its April level, measured monthly", owner: "cfo", requiresApproval: true },
          { id: "cfo-2", action: "Treat refund reduction as the first margin lever: track refunds as a share of gross sales weekly.", lever: "refunds", direction: "decrease", successMetric: "Refunds as a share of gross sales back toward the April level, measured weekly", owner: "coo", requiresApproval: true },
        ],
        missingInformation: ["Margin by product line", "Refund cost by reason code", "Channel-level marketing spend"],
      };
    case "sales":
      return {
        agent, roleVersion,
        findings: compact<Finding>([
          measured(ctx, "conversionPct", " while sessions kept rising"),
          measured(ctx, "repeatOrderSharePct"),
          measured(ctx, "orders"),
          { text: "Falling repeat orders suggest returning customers had worse experiences; refunds alone do not establish why first-time conversion fell.", kind: "hypothesis", evidence: ["repeatOrderSharePct", "conversionPct"] },
        ]),
        recommendations: [
          { id: "sales-1", action: "Instrument the checkout funnel to find the step where conversion dropped before changing offers.", lever: "checkoutFunnel", direction: "investigate", successMetric: "Step-level drop-off known for the most recent month", owner: "sales", requiresApproval: true },
          { id: "sales-2", action: "Win back customers whose last order was refunded or late, after fulfilment fixes are in place.", lever: "retention", direction: "increase", successMetric: "Orders from returning customers back above 45%", owner: "sales", requiresApproval: true },
        ],
        missingInformation: ["Funnel step data", "Reviews and ratings over time", "Price changes in the period"],
      };
    case "cmo":
      return {
        agent, roleVersion,
        findings: compact<Finding>([
          measured(ctx, "marketingSpendUsd"),
          measured(ctx, "cacUsd"),
          measured(ctx, "csatPct"),
          { text: "Paid acquisition is buying traffic that converts worse; dissatisfied customers may be depressing reviews and word of mouth.", kind: "hypothesis", evidence: ["cacUsd", "csatPct", "conversionPct"] },
        ]),
        recommendations: [
          { id: "cmo-1", action: "Add a retention budget (loyalty email and service-recovery offers) to rebuild repeat purchase.", lever: "marketingSpend", direction: "increase", successMetric: "Repeat order share above a holdout group after two months", owner: "cmo", requiresApproval: true },
          { id: "cmo-2", action: "Run a two-week holdout on the most expensive acquisition channel to measure its real lift.", lever: "acquisitionChannels", direction: "investigate", successMetric: "Measured incremental orders per channel", owner: "cmo", requiresApproval: true },
        ],
        missingInformation: ["Spend and new customers by channel", "Review volume and rating trend"],
      };
    case "coo":
      return {
        agent, roleVersion,
        findings: compact<Finding>([
          measured(ctx, "refundRatePct"),
          measured(ctx, "lateShipmentPct"),
          measured(ctx, "defectReturnSharePct"),
          measured(ctx, "firstResponseHours"),
          cap && { text: `At ${cap.assumption}, September support needed about ${cap.neededHours} hours against ${cap.availableHours} available (${cap.utilizationPct}% utilization).`, kind: "measured" as const, evidence: ["support_capacity", ...cap.evidence] },
          { text: "Late shipments and defective items are the likeliest drivers of refunds and tickets; carrier or supplier changes in May–June would confirm it.", kind: "hypothesis", evidence: ["lateShipmentPct", "defectReturnSharePct"] },
        ]).slice(0, 6),
        recommendations: [
          { id: "coo-1", action: "Audit carrier and warehouse performance for orders shipped since May and fix the worst lane first.", lever: "fulfilment", direction: "investigate", successMetric: "Late shipments back toward the April rate, measured weekly", owner: "coo", requiresApproval: true },
          { id: "coo-2", action: "Inspect the products behind defect returns with the supplier before reordering.", lever: "productQuality", direction: "investigate", successMetric: "Defect returns a smaller share of refunds than in September", owner: "coo", requiresApproval: true },
          { id: "coo-3", action: "Automate routine refund tickets with the JARVIS pattern (AI proposes, policy decides, read-back verifies) to free agent time.", lever: "supportAutomation", direction: "increase", successMetric: "Median first response under 6 hours", owner: "coo", requiresApproval: true },
        ],
        missingInformation: ["Carrier and warehouse by order", "Defect returns by product", "Ticket reasons"],
      };
    case "hr":
      return {
        agent, roleVersion,
        findings: compact<Finding>([
          measured(ctx, "ticketsPerAgent", " as support headcount fell from 6 to 5.5 FTE"),
          measured(ctx, "firstResponseHours"),
          cap && { text: `Under the stated assumption (${cap.assumption}) the team ran at about ${cap.utilizationPct}% of capacity in September.`, kind: "measured" as const, evidence: ["support_capacity", ...cap.evidence] },
          { text: "Sustained overload risks errors and attrition; the assumption about handling time should be measured before hiring.", kind: "hypothesis", evidence: ["ticketsPerAgent", "support_capacity"] },
        ]),
        recommendations: [
          { id: "hr-1", action: "Option for the owner: add temporary support capacity for 8 weeks while the ticket backlog clears.", lever: "supportCapacity", direction: "increase", successMetric: "Tickets per agent back toward the April level", owner: "hr", requiresApproval: true },
          { id: "hr-2", action: "Train agents on a shared triage guide for late-delivery and defect tickets.", lever: "training", direction: "increase", successMetric: "Fewer repeat contacts per ticket than before training, on the same ticket types", owner: "hr", requiresApproval: true },
        ],
        missingInformation: ["Measured handling time per ticket", "Overtime and absence (aggregate only)"],
      };
    case "ceo":
    default:
      return {
        agent, roleVersion,
        findings: compact<Finding>([
          measured(ctx, "netRevenue"),
          measured(ctx, "grossMarginPct"),
          measured(ctx, "csatPct"),
          { text: "Revenue, margin and satisfaction fell together, which points to one operational cause more than three separate problems.", kind: "hypothesis", evidence: ["netRevenue", "grossMarginPct", "csatPct"] },
        ]),
        recommendations: [],
        missingInformation: [],
      };
  }
}

/** Private-chat answer: the role's own findings that match the question, with citations. */
export function fixtureReply(agent: AgentId, question: string, ctx: ScopedContext): { text: string; evidence: string[] } {
  const role = agentById(agent);
  const analysis = fixtureAnalysis(agent, question, ctx);
  const words = question.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  const score = (t: string) => words.filter((w) => t.toLowerCase().includes(w)).length;
  const ranked = [...analysis.findings].sort((a, b) => score(b.text) - score(a.text));
  const top = ranked.slice(0, 2);
  const recs = analysis.recommendations.slice(0, 1);
  const lines = [
    ...top.map((f) => `${f.kind === "measured" ? "Measured" : "Hypothesis"}: ${f.text}`),
    ...recs.map((r) => `Proposal (needs your approval): ${r.action}`),
  ];
  if (words.length > 0 && top.every((f) => score(f.text) === 0)) {
    lines.unshift(`That is outside what I can see. My data: ${Object.values(ctx.metrics).map((x) => x!.label.toLowerCase()).join(", ")}. Closest from my area:`);
  }
  lines.push(`(${role.short}, fixture rules over synthetic data; not a language model.)`);
  return { text: lines.join("\n"), evidence: [...new Set(top.flatMap((f) => f.evidence))] };
}
