// Bounded boardroom orchestration. Control flow is deterministic; specialists only return structured proposals.
//   request → topics → agent selection → scoped context → specialist analyses (budgeted, validated)
//   → conflict review → executive synthesis → proposed plan (every action needs owner approval) → audit
// No loop: each selected specialist is called at most once per request, then the CEO synthesis is computed.
import { AGENTS, SpecialistOutput, TEAM_TOOLS, agentById, type AgentId, type Topic } from "./agents.ts";
import { scopedContext, type SharedNote } from "./context.ts";
import { unsupportedFigures } from "./figures.ts";
import { DATASET_META } from "./dataset.ts";
import { marginBridge, computeMetrics } from "./metrics.ts";
import type { ProviderInfo, TeamProvider } from "./provider.ts";

export interface Budgets {
  maxSpecialists: number; // excluding the CEO synthesis
  maxCalls: number;
  perCallTimeoutMs: number;
  maxOutputChars: number; // stand-in token budget for fixture output; a live adapter would count tokens
}
export const DEFAULT_BUDGETS: Budgets = { maxSpecialists: 5, maxCalls: 6, perCallTimeoutMs: 15000, maxOutputChars: 8000 };

export type AuditEvent = { seq: number; at: string; type: string; detail: string; agent?: AgentId };

export interface Analysis {
  agent: AgentId;
  status: "ok" | "invalid" | "timeout" | "error" | "cancelled" | "skipped_budget";
  output?: SpecialistOutput;
  error?: string;
  provider: ProviderInfo;
  latencyMs: number;
  rejectedTools: string[];
}

export interface Conflict {
  lever: string;
  positions: { agent: AgentId; recommendationId: string; direction: string; action: string }[];
  resolution: string;
}

export interface PlanAction {
  id: string;
  order: number;
  action: string;
  owner: AgentId;
  proposedBy: AgentId;
  successMetric: string;
  lever: string;
  status: "proposed";
  requiresApproval: true;
  note?: string;
}

export interface BoardroomResult {
  request: string;
  topics: Topic[];
  selected: AgentId[];
  analyses: Analysis[];
  conflicts: Conflict[];
  report: {
    diagnosis: { text: string; evidence: string[]; from: AgentId; alsoFrom: AgentId[] }[];
    hypotheses: { text: string; evidence: string[]; from: AgentId }[];
    actions: PlanAction[];
    expectedImpact: { text: string; assumption: string; evidence: string[] }[];
    risks: string[];
    plan30: { window: string; milestone: string; owner: AgentId }[];
    humanDecisions: string[];
    missingInformation: string[];
    /** Private-chat messages the owner shared and the specialists received. */
    sharedConsidered: SharedNote[];
  };
  provider: ProviderInfo;
  calls: number;
  audit: AuditEvent[];
  cancelled: boolean;
}

const TOPIC_WORDS: Record<Topic, RegExp> = {
  sales: /\b(sales|revenue|conversion|orders?|funnel|customers?)\b/i,
  margin: /\b(margin|profit|costs?|finance|cash|refund|price)/i,
  quality: /\b(quality|refunds?|returns?|defect|late|shipping|fulfil|support|satisfaction|csat|complain)/i,
  marketing: /\b(marketing|campaign|acquisition|brand|retention|ads?)\b/i,
  staffing: /\b(staff|team|hiring|capacity|workload|agents?|people|training)\b/i,
  strategy: /\b(strategy|priorit|plan|recover|business|performance|investigate|improve)/i,
};

export function classifyTopics(request: string): Topic[] {
  const topics = (Object.keys(TOPIC_WORDS) as Topic[]).filter((t) => TOPIC_WORDS[t].test(request));
  return topics.length ? topics : ["strategy"];
}

/** Specialists whose topics overlap the request, in a fixed order; the CEO always synthesizes. */
export function selectAgents(topics: Topic[], maxSpecialists = DEFAULT_BUDGETS.maxSpecialists): AgentId[] {
  const broad = topics.includes("strategy") && topics.length === 1;
  const picked = AGENTS.filter((a) => a.id !== "ceo" && (broad || a.topics.some((t) => topics.includes(t)))).map((a) => a.id);
  return [...picked.slice(0, maxSpecialists), "ceo"];
}

function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      controller.abort(new Error("timeout"));
      reject(new Error("timeout"));
    }, ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

export async function runBoardroom(
  request: string,
  provider: TeamProvider,
  opts: { budgets?: Partial<Budgets>; signal?: AbortSignal; shared?: SharedNote[]; now?: () => Date; onProgress?: (a: Analysis) => void; agents?: AgentId[] } = {},
): Promise<BoardroomResult> {
  const b = { ...DEFAULT_BUDGETS, ...opts.budgets };
  const now = opts.now ?? (() => new Date());
  const audit: AuditEvent[] = [];
  const log = (type: string, detail: string, agent?: AgentId) => audit.push({ seq: audit.length + 1, at: now().toISOString(), type, detail, agent });
  const text = request.trim().slice(0, 2000);
  log("REQUEST", text);

  const topics = classifyTopics(text);
  // The owner may name the specialists (staged live tests: CFO alone, then CFO + COO + CEO). Order stays fixed
  // and the CEO, when present, always runs last; the call budget still applies.
  const chosen = opts.agents?.length ? AGENTS.map((a) => a.id).filter((id) => id !== "ceo" && opts.agents!.includes(id)).slice(0, b.maxSpecialists) : null;
  const selected = chosen ? [...chosen, ...(opts.agents!.includes("ceo") ? (["ceo"] as AgentId[]) : [])] : selectAgents(topics, b.maxSpecialists);
  log("ROUTED", `topics ${topics.join(", ")} → ${selected.join(", ")}${chosen ? " (owner-chosen)" : ""}`);

  const analyses: Analysis[] = [];
  let calls = 0;
  let cancelled = false;
  for (const agent of selected) {
    if (opts.signal?.aborted) {
      cancelled = true;
      analyses.push({ agent, status: "cancelled", provider: provider.info, latencyMs: 0, rejectedTools: [] });
      log("CANCELLED", "owner cancelled before this specialist ran", agent);
      continue;
    }
    if (calls >= b.maxCalls) {
      analyses.push({ agent, status: "skipped_budget", provider: provider.info, latencyMs: 0, rejectedTools: [] });
      log("BUDGET", `call budget of ${b.maxCalls} reached`, agent);
      continue;
    }
    calls++;
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error("cancelled"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const ctx = scopedContext(agent, (opts.shared ?? []).filter((s) => s.text.trim().length > 0));
    log("CONTEXT", `${Object.keys(ctx.metrics).length} metrics, tools ${Object.keys(ctx.tools).join(", ") || "none"}, ${ctx.shared.length} shared notes`, agent);
    const t0 = Date.now();
    let a: Analysis;
    try {
      const res = await withTimeout(provider.analyze(agent, text, ctx, controller.signal), b.perCallTimeoutMs, controller);
      const size = JSON.stringify(res.output ?? null).length;
      const parsed = SpecialistOutput.safeParse(res.output);
      if (size > b.maxOutputChars) {
        a = { agent, status: "invalid", error: `output over budget (${size} > ${b.maxOutputChars} chars)`, provider: res.provider, latencyMs: res.latencyMs, rejectedTools: [] };
      } else if (!parsed.success || parsed.data.agent !== agent) {
        a = { agent, status: "invalid", error: parsed.success ? "answered for a different role" : schemaError(parsed.error.issues), provider: res.provider, latencyMs: res.latencyMs, rejectedTools: [] };
      } else {
        // Tool allowlist: a recommendation that asks for a tool outside the role's read-only tools is dropped.
        const role = agentById(agent);
        const rejectedTools: string[] = [];
        // Figure check (same rule as private replies): no finding, proposal or note may state a number the
        // deterministic calculations do not support. Offending items are withheld, never shown with a warning.
        const unsupported: string[] = [];
        const recommendations = parsed.data.recommendations.filter((r) => {
          const toolOk = !r.tool || ((TEAM_TOOLS as readonly string[]).includes(r.tool) && role.tools.includes(r.tool as never));
          if (!toolOk) rejectedTools.push(r.tool!);
          const bad = unsupportedFigures(`${r.action} ${r.successMetric}`, ctx);
          if (bad.length) unsupported.push(`${bad.join(", ")} in proposal "${r.action.slice(0, 80)}"`);
          return toolOk && bad.length === 0;
        });
        const missingInformation = parsed.data.missingInformation.filter((m) => {
          const bad = unsupportedFigures(m, ctx);
          if (bad.length) unsupported.push(`${bad.join(", ")} in note "${m.slice(0, 80)}"`);
          return bad.length === 0;
        });
        const findings = parsed.data.findings.filter((f) => {
          const bad = unsupportedFigures(f.text, ctx);
          if (bad.length) unsupported.push(`${bad.join(", ")} in "${f.text.slice(0, 80)}"`);
          return bad.length === 0;
        });
        for (const u of unsupported) log("FIGURE_REJECTED", `unsupported figure ${u}`, agent);
        a =
          findings.length === 0
            ? { agent, status: "invalid", error: "every finding stated figures the data does not support", provider: res.provider, latencyMs: res.latencyMs, rejectedTools }
            : { agent, status: "ok", output: { ...parsed.data, findings, recommendations, missingInformation }, provider: res.provider, latencyMs: res.latencyMs, rejectedTools };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = opts.signal?.aborted ? "cancelled" : msg === "timeout" ? "timeout" : "error";
      if (status === "cancelled") cancelled = true;
      a = { agent, status, error: msg, provider: provider.info, latencyMs: Date.now() - t0, rejectedTools: [] };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
    for (const t of a.rejectedTools) log("TOOL_REJECTED", `requested "${t}", not in this role's read-only tools`, agent);
    log(a.status === "ok" ? "ANALYSIS" : `ANALYSIS_${a.status.toUpperCase()}`, a.status === "ok" ? `${a.output!.findings.length} findings, ${a.output!.recommendations.length} proposals via ${a.provider.kind}` : a.error ?? a.status, agent);
    analyses.push(a);
    opts.onProgress?.(a);
  }

  const ok = analyses.filter((a) => a.status === "ok" && a.output);
  for (const a of ok)
    for (const r of a.output!.recommendations) {
      const mapped = normalizeLever(r.lever, r.action);
      if (mapped !== r.lever) log("LEVER_MAPPED", `"${r.lever.slice(0, 60)}" → ${mapped}`, a.agent);
      r.lever = mapped;
    }
  const conflicts = findConflicts(ok);
  for (const c of conflicts) log("CONFLICT", `${c.lever}: ${c.positions.map((p) => `${p.agent} ${p.direction}`).join(" vs ")}`);
  const report = synthesize(ok, conflicts, (opts.shared ?? []).filter((s) => s.text.trim().length > 0));
  log("PLAN", `${report.actions.length} proposed actions, all awaiting owner approval; nothing executed`);
  return { request: text, topics, selected, analyses, conflicts, report, provider: provider.info, calls, audit, cancelled };
}

export function findConflicts(ok: Analysis[]): Conflict[] {
  const byLever = new Map<string, Conflict["positions"]>();
  for (const a of ok)
    for (const r of a.output!.recommendations) {
      if (r.direction !== "increase" && r.direction !== "decrease") continue;
      byLever.set(r.lever, [...(byLever.get(r.lever) ?? []), { agent: a.agent, recommendationId: r.id, direction: r.direction, action: r.action }]);
    }
  return [...byLever]
    .filter(([, ps]) => new Set(ps.map((p) => p.direction)).size > 1)
    .map(([lever, positions]) => ({
      lever,
      positions,
      resolution: "Owner decision. CEO proposal: keep the total level unchanged and test the change inside it first, so the disagreement is settled by measurement.",
    }));
}

const PRIORITY: string[] = ["refunds", "fulfilment", "productQuality", "supportAutomation", "supportCapacity", "checkoutFunnel", "acquisitionChannels", "marketingSpend", "retention", "training"];
/** The fixed lever vocabulary specialists are asked to use. */
export const LEVERS = [...PRIORITY, "costs"] as const;

const LEVER_RULES: [RegExp, string][] = [
  [/refund|return/i, "refunds"],
  [/fulfil|fulfill|ship|warehouse|deliver|carrier|logistic/i, "fulfilment"],
  [/defect|quality|supplier/i, "productQuality"],
  [/automat|ai[- ]driven|routing|chatbot|self[- ]service/i, "supportAutomation"],
  [/support|staff|capacity|first response|ticket|headcount|hiring/i, "supportCapacity"],
  [/checkout|conversion|funnel|page load|website/i, "checkoutFunnel"],
  [/acquisition|cac|channel|media|\bads?\b|creative|targeting/i, "acquisitionChannels"],
  [/retention|loyal|repeat|win[- ]back|satisfaction|csat/i, "retention"],
  [/marketing|spend|budget/i, "marketingSpend"],
  [/train/i, "training"],
  [/cogs|cost|pric|margin/i, "costs"],
];

/**
 * Maps a model's free-text lever onto the fixed vocabulary by keyword, deterministically, so conflicts and
 * the mission link compare like with like. The lever text is tried first, then the action text. Unknown
 * levers are kept as written (lower-cased). Every remapping is audited.
 */
export function normalizeLever(lever: string, action: string): string {
  if ((LEVERS as readonly string[]).includes(lever)) return lever;
  for (const text of [lever, action]) for (const [re, l] of LEVER_RULES) if (re.test(text)) return l;
  return lever.trim().toLowerCase();
}

const schemaError = (issues: { path: PropertyKey[]; message: string }[]) => {
  const i = issues[0];
  return i ? `${i.path.map(String).join(".") || "output"}: ${i.message}` : "schema";
};

export function synthesize(ok: Analysis[], conflicts: Conflict[], shared: SharedNote[] = []): BoardroomResult["report"] {
  const findings = ok.flatMap((a) => a.output!.findings.map((f) => ({ ...f, from: a.agent })));
  const conflicted = new Set(conflicts.flatMap((c) => c.positions.map((p) => p.recommendationId)));
  const recs = ok.flatMap((a) => a.output!.recommendations.map((r) => ({ ...r, proposedBy: a.agent })));
  const rank = (lever: string) => (PRIORITY.indexOf(lever) === -1 ? 99 : PRIORITY.indexOf(lever));
  const actions: PlanAction[] = recs
    .sort((x, y) => rank(x.lever) - rank(y.lever))
    .map((r, i) => ({
      id: r.id, order: i + 1, action: r.action, owner: r.owner, proposedBy: r.proposedBy, successMetric: r.successMetric, lever: r.lever, status: "proposed", requiresApproval: true,
      ...(conflicted.has(r.id) ? { note: "Disputed: see the conflict above; decide before approving." } : {}),
    }));

  const m = computeMetrics();
  const bridge = marginBridge();
  const expectedImpact = [
    {
      text: `If refunds returned to April's share of gross sales, September margin would be about ${Math.abs(bridge.fromRefundsPts)} points higher (≈$${bridge.excessRefundsUsd.toLocaleString("en-US")} a month at September sales).`,
      assumption: "Same sales and costs as September; only the refund share changes.",
      evidence: ["margin_bridge", ...bridge.evidence],
    },
    {
      text: `Halving the drop in conversion (${m.conversionPct.first}% → ${m.conversionPct.last}%) at September traffic would add about ${Math.round(((m.conversionPct.first - m.conversionPct.last) / 2 / 100) * 180000).toLocaleString("en-US")} orders a month.`,
      assumption: "Range, not a forecast: depends on causes the team has not yet confirmed.",
      evidence: ["conversionPct", "M-2026-09"],
    },
  ];

  const owners = new Set(actions.map((a) => a.owner));
  const plan30: BoardroomResult["report"]["plan30"] = [
    { window: "Days 1–7", milestone: "Collect the missing data the specialists named; confirm refund and late-shipment causes.", owner: "coo" },
    { window: "Days 8–14", milestone: "COO fixes the worst fulfilment lane and supplier issue; Sales starts funnel instrumentation.", owner: "coo" },
    { window: "Days 15–21", milestone: "Run the agreed marketing experiment inside a fixed budget; win-back pilot for affected customers.", owner: owners.has("cmo") ? "cmo" : "ceo" },
    { window: "Days 22–30", milestone: "Review measured results against each success metric; decide what to scale or stop.", owner: "ceo" },
  ];

  return {
    diagnosis: dedupeMeasured(findings.filter((f) => f.kind === "measured")),
    hypotheses: findings.filter((f) => f.kind === "hypothesis"),
    actions,
    expectedImpact,
    risks: [
      "The synthetic records may not reflect a real store; every number is an illustration of the method.",
      "Cutting acquisition spend too early could reduce new customers further.",
      "Fixes to fulfilment take weeks to show in satisfaction and repeat orders.",
      "Added temporary support capacity costs money before the backlog falls.",
    ],
    plan30,
    humanDecisions: [
      "Approve or reject each proposed action; JARVIS executes none of them.",
      ...conflicts.map((c) => `Resolve the disagreement on ${c.lever}.`),
      "Any spend, hiring, pricing or customer communication needs the owner's sign-off.",
    ],
    missingInformation: [...new Set(ok.flatMap((a) => a.output!.missingInformation))],
    sharedConsidered: shared,
  };
}

export const DATASET_LABEL = DATASET_META.label;

/** One line per measured metric: when two specialists cite the same metric, keep the first and credit both. */
export function dedupeMeasured<T extends { evidence: string[]; from: AgentId; text: string }>(items: T[]): (T & { alsoFrom: AgentId[] })[] {
  const seen = new Map<string, T & { alsoFrom: AgentId[] }>();
  for (const f of items) {
    const key = f.evidence[0] ?? f.text;
    const hit = seen.get(key);
    if (hit) {
      if (hit.from !== f.from && !hit.alsoFrom.includes(f.from)) hit.alsoFrom.push(f.from);
    } else seen.set(key, { ...f, alsoFrom: [] });
  }
  return [...seen.values()];
}
