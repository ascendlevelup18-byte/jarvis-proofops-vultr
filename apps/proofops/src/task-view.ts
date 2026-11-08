// What a chat client sees of a task: short statuses taken from real run events, and a final result taken from the sealed
// evidence. Model text, field values, session ids and URLs stay out, so normal chat carries no execution trace.
import { CATALOG, formatUsd, type Sku } from "./fixtures.ts";
import type { RunSummary } from "./run-summary.ts";

export type TaskPhase = "starting" | "acting" | "awaiting_approval" | "verifying" | "finished";
export interface TaskStatus { seq: number; at: string; phase: TaskPhase; message: string }
export type TaskOutcome = "VERIFIED_PASS" | "VERIFIED_FAIL" | "INCOMPLETE" | "EXECUTION_ERROR";

export interface TaskResult {
  outcome: TaskOutcome;
  message: string;
  /** For a website audit: the verified findings. */
  audit?: { pagesChecked: number; broken: { from: string; href: string }[]; reported: string[]; missed: string[]; falseFindings: string[] };
  facts: { sku: string | null; quantity: number | null; coupon: string | null; totalCents: number | null; expectedTotalCents: number | null; ordersPlaced: number | null; checkoutReached: boolean | null };
  planner: { live: boolean; label: string };
  evidence: { integrity: string; manifestSha256: string | null; summaryPath: string; filesPath: string };
}

const PAGES: Record<string, string> = { "/": "the shop page", "/cart": "the cart", "/checkout": "checkout", "/checkout/submit": "the order page" };
function pageFrom(result: unknown): string | null {
  const url = /^ok (https?:\/\/\S+)/.exec(String(result ?? ""))?.[1];
  if (!url) return null;
  try { return PAGES[new URL(url).pathname.replace(/^\/s\/[^/]+/, "") || "/"] ?? "a store page"; } catch { return null; }
}
const words = (s: unknown) => String(s ?? "unknown").replaceAll("_", " ");

/** One short line for a recorded step, or null if it has nothing to say. Never includes the model's words. */
export function statusFromStep(s: Record<string, any>): { phase: TaskPhase; message: string } | null {
  const tool = s.proposal?.tool;
  const decision = s.policy?.decision;
  if (decision === "deny") return { phase: "acting", message: `Policy refused a proposed action (${words(s.policy?.rule)}).` };
  if (decision === "needs_approval") return s.approved === true ? null : { phase: "acting", message: "The order step wasn't performed, because it wasn't approved." };
  if (decision !== "allow") return null;
  if (tool === "finish") return { phase: "verifying", message: "The agent stopped. Checking the result independently." };
  const page = pageFrom(s.result);
  if (tool === "fill") return { phase: "acting", message: "Filled in a field." };
  if (tool === "click") return { phase: "acting", message: page ? `Clicked, now on ${page}.` : "Clicked." };
  if (tool === "navigate") return { phase: "acting", message: page ? `Opened ${page}.` : "Opened a page." };
  return null;
}

/** One short line for a recorded run event, or null for the ones that don't matter in a chat. */
export function statusFromEvent(e: Record<string, any>): { phase: TaskPhase; message: string } | null {
  switch (e.type) {
    case "spec.frozen": return { phase: "starting", message: "Goal frozen." };
    case "worker.started": return { phase: "starting", message: "Browser started." };
    case "gateway.denied": return { phase: "acting", message: "The network gateway blocked a request." };
    case "approval.requested": return { phase: "awaiting_approval", message: "Waiting for your approval of this exact cart." };
    case "approval.granted": return { phase: "acting", message: "Approved. Placing the order." };
    case "approval.refused": return { phase: "acting", message: "No approval was given, so no order will be placed." };
    case "run.wall_clock_expired": return { phase: "verifying", message: "The time limit was reached." };
    case "verifier.dom_read": return { phase: "verifying", message: "Checking the page and the store's records." };
    case "cleanup.done": return { phase: "verifying", message: e.workerGone ? "Browser destroyed." : "The browser may not have been destroyed." };
    default: return null;
  }
}

export function plannerLabel(provider: string | null | undefined, model?: string | null): { live: boolean; label: string } {
  if (provider === "vultr-serverless-inference") return { live: true, label: `Live model: ${model ?? "unknown"} on Vultr` };
  if (provider === "local-model-stub") return { live: false, label: "Scripted planner, no live AI" };
  return { live: false, label: "Planner not recorded" };
}

function whyFailed(s: RunSummary): string {
  const fail = s.checks.filter((c) => c.outcome === "FAIL");
  const total = fail.find((c) => c.name === "server.total") ?? fail.find((c) => c.name === "dom.total");
  if (total && typeof total.expected === "number" && typeof total.observed === "number") return `expected ${formatUsd(total.expected)}, the store recorded ${formatUsd(total.observed)}`;
  const item = fail.find((c) => c.name === "server.cart_item");
  if (item) return `expected quantity ${(item.expected as { quantity?: number })?.quantity ?? "unknown"}, the store's cart had ${(item.observed as { quantity?: number } | null)?.quantity ?? "nothing"}`;
  if (fail.some((c) => c.name === "orders.count")) return `expected ${s.expected?.ordersExpected ?? "a different number of"} orders, the store recorded ${s.observed?.orders ?? "unknown"}`;
  if (fail.some((c) => c.name === "checkout.not_reached")) return "the goal was to stop at the cart, and the agent went to checkout";
  if (fail.some((c) => c.name === "checkout.reached")) return "the agent didn't reach checkout";
  return `the ${fail[0]?.name ?? "verifier"} check failed`;
}

/** The final answer for chat. Only a sealed verifier result can produce a VERIFIED outcome. */
function auditResult(s: RunSummary): TaskResult | null {
  const missedCheck = s.checks.find((c) => c.name === "qa.no_missed_findings");
  if (!missedCheck) return null;
  const truth = (missedCheck.expected as { from: string; href: string }[]) ?? [];
  const obs = (missedCheck.observed as { reported?: string[]; missed?: string[] }) ?? {};
  const falseFindings = (s.checks.find((c) => c.name === "qa.no_false_findings")?.observed as string[]) ?? [];
  const pages = ((s.checks.find((c) => c.name === "qa.pages_covered")?.expected as string[]) ?? []).length;
  const list = (xs: { from: string; href: string }[]) => xs.map((b) => `${b.href} (linked from ${b.from})`).join(", ");
  let outcome: TaskOutcome;
  let message: string;
  if (s.outcomeClass === "verified_success") {
    outcome = "VERIFIED_PASS";
    message = truth.length
      ? `Audit done, and verified against the site's real state: I checked ${pages} pages and found ${truth.length} broken link${truth.length === 1 ? "" : "s"}: ${list(truth)}. The browser opened each one and got "Page not found".`
      : `Audit done, and verified against the site's real state: I checked ${pages} pages and found no broken links.`;
  } else if (s.outcomeClass === "verified_fail") {
    outcome = "VERIFIED_FAIL";
    const parts = [];
    if (obs.missed?.length) parts.push(`it missed ${obs.missed.join(", ")}`);
    if (falseFindings.length) parts.push(`it reported ${falseFindings.join(", ")}, which ${falseFindings.length === 1 ? "isn't" : "aren't"} broken`);
    const notCovered = (s.checks.find((c) => c.name === "qa.pages_covered")?.observed as { missing?: string[] })?.missing ?? [];
    if (notCovered.length) parts.push(`it never opened ${notCovered.join(", ")}`);
    message = `The audit ran, but it didn't hold up against the site's real state: ${parts.join("; ") || "a check failed"}.`;
  } else return null;
  return {
    outcome, message, audit: { pagesChecked: pages, broken: truth, reported: obs.reported ?? [], missed: obs.missed ?? [], falseFindings },
    facts: { sku: null, quantity: null, coupon: null, totalCents: null, expectedTotalCents: null, ordersPlaced: s.observed?.orders ?? null, checkoutReached: s.observed?.checkoutReached ?? null },
    planner: plannerLabel(s.model?.provider, s.model?.requested),
    evidence: { integrity: s.evidence.integrity_status, manifestSha256: s.evidence.manifestSha256, summaryPath: `/api/runs/${s.runId}/summary`, filesPath: `/api/runs/${s.runId}/evidence/` },
  };
}

export function resultFromSummary(s: RunSummary): TaskResult {
  const audit = auditResult(s);
  if (audit) return audit;
  const cart = s.checks.find((c) => c.name === "server.cart_item")?.observed as { sku?: string; quantity?: number } | null | undefined;
  const facts: TaskResult["facts"] = {
    sku: cart?.sku ?? null, quantity: cart?.quantity ?? null, coupon: s.observed?.coupon ?? null, totalCents: s.observed?.totals?.totalCents ?? null,
    expectedTotalCents: s.expected?.totalCents ?? null, ordersPlaced: s.observed?.orders ?? null, checkoutReached: s.observed?.checkoutReached ?? null,
  };
  let outcome: TaskOutcome;
  let message: string;
  switch (s.outcomeClass) {
    case "verified_success": {
      outcome = "VERIFIED_PASS";
      const name = cart?.sku ? CATALOG[cart.sku as Sku]?.name ?? cart.sku : "the item";
      const code = facts.coupon ? `, code ${facts.coupon}` : ", no code";
      const end = facts.ordersPlaced ? `${facts.ordersPlaced} synthetic order placed with your approval.` : facts.checkoutReached ? "Reached checkout, no order placed." : "Stopped at the cart, no order placed.";
      message = `Done, and verified against the store's records: ${facts.quantity ?? "?"} × ${name}${code}, total ${facts.totalCents === null ? "not recorded" : formatUsd(facts.totalCents)}. ${end}`;
      break;
    }
    case "verified_fail": outcome = "VERIFIED_FAIL"; message = `The task ran, but the result didn't match: ${whyFailed(s)}.`; break;
    case "order_not_approved": outcome = "INCOMPLETE"; message = "No approval was given, so no order was placed and the goal wasn't met."; break;
    case "timed_out": outcome = "INCOMPLETE"; message = "The task hit its time limit, so it wasn't verified."; break;
    case "cancelled": outcome = "INCOMPLETE"; message = "The task was cancelled, so it wasn't verified."; break;
    case "incomplete_evidence": outcome = "INCOMPLETE"; message = "The record is incomplete, so this can't be called verified."; break;
    case "evidence_integrity_failure": outcome = "INCOMPLETE"; message = "The evidence files don't match their recorded checksums, so don't rely on this result."; break;
    case "unexpected_failure": outcome = "EXECUTION_ERROR"; message = "The run didn't complete cleanly, so it proves nothing about your goal."; break;
    default: outcome = "INCOMPLETE"; message = "This run can't be called verified.";
  }
  return {
    outcome, message, facts, planner: plannerLabel(s.model?.provider, s.model?.requested),
    evidence: { integrity: s.evidence.integrity_status, manifestSha256: s.evidence.manifestSha256, summaryPath: `/api/runs/${s.runId}/summary`, filesPath: `/api/runs/${s.runId}/evidence/` },
  };
}
