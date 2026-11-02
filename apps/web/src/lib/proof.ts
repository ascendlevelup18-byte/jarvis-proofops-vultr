// Proof Mode derivations. Pure functions over the recorded Case only: nothing here
// invents steps, timing or outcomes. A stage with no recorded data is "not reached"
// or "skipped", never "done".
import type { AuditEvent, AuthorizationDecision, Case } from "./case-types.ts";
import { formatMinor } from "./money.ts";
import { CHECK_LABELS, REASON_LABELS } from "./verdict.ts";

/** Who produced a stage's content. Drives colour: input, AI (purple), policy (green), execution (blue). */
export type ProofOrigin = "input" | "ai" | "records" | "policy" | "execution";
export type ProofStatus = "done" | "blocked" | "failed" | "skipped" | "not-reached";

export interface ProofStage {
  id: "complaint" | "understanding" | "evidence" | "proposal" | "policy" | "execution" | "verification";
  label: string;
  origin: ProofOrigin;
  status: ProofStatus;
  headline: string;
  detail: string;
  /** DOM id of the panel holding the full record. */
  anchor: string;
}

const reasonFor = (c: Case, prefix: string) => c.reasons.find((r) => r.code.startsWith(prefix));
const label = (code: string) => CHECK_LABELS[code] ?? REASON_LABELS[code] ?? code;
const failedChecks = (a: AuthorizationDecision | null) => a?.checks.filter((k) => !k.passed) ?? [];

/** Stages in the order the engine runs them. */
export function deriveProofChain(c: Case): ProofStage[] {
  const ev = c.evidence;
  const auth = c.authorization;
  const stale = c.reasons.find((r) => r.code === "STALE_EVIDENCE");

  const understanding: ProofStage = c.understanding
    ? {
        id: "understanding",
        label: "AI understanding",
        origin: "ai",
        status: "done",
        headline: c.understanding.intent.replaceAll("_", " "),
        detail: c.understanding.mentionedAmounts.length
          ? `Stated amounts: ${c.understanding.mentionedAmounts.map((m) => m.text).join(", ")}`
          : "No amounts stated",
        anchor: "understanding-panel",
      }
    : notRecorded("understanding", "AI understanding", "ai", reasonFor(c, "UNDERSTANDING_"), "understanding-panel");

  const evidence: ProofStage = ev
    ? {
        id: "evidence",
        label: "Evidence",
        origin: "records",
        status: ev.contradictions.length ? "blocked" : "done",
        headline: `${ev.transactions.length} charge${ev.transactions.length === 1 ? "" : "s"} · ${ev.financial.status.replaceAll("_", " ")}`,
        detail: ev.contradictions.length
          ? `${ev.contradictions.length} contradiction${ev.contradictions.length === 1 ? "" : "s"}: ${ev.contradictions[0]}`
          : `${ev.duplicateGroups.length} duplicate group${ev.duplicateGroups.length === 1 ? "" : "s"} · ${ev.refunds.length} prior refund${ev.refunds.length === 1 ? "" : "s"}`,
        anchor: "evidence-panel",
      }
    : c.understanding && c.reasons[0]
      ? {
          id: "evidence",
          label: "Evidence",
          origin: "records",
          status: "blocked",
          headline: label(c.reasons[0].code),
          detail: c.reasons[0].detail,
          anchor: "evidence-panel",
        }
      : notRecorded("evidence", "Evidence", "records", undefined, "evidence-panel");

  const proposal: ProofStage = c.proposal
    ? {
        id: "proposal",
        label: "AI proposal",
        origin: "ai",
        status: "done",
        headline: c.proposal.action.replaceAll("_", " "),
        detail: `Confidence ${(c.proposal.confidence * 100).toFixed(0)}% (advisory) · no execution authority`,
        anchor: "ai-proposal",
      }
    : notRecorded("proposal", "AI proposal", "ai", reasonFor(c, "MODEL_"), "ai-proposal");

  let policy: ProofStage;
  if (!auth) {
    policy = notRecorded("policy", "Policy", "policy", undefined, "authorization-gate");
  } else if (auth.outcome === "DENY") {
    const failed = failedChecks(auth);
    policy = {
      id: "policy",
      label: "Policy",
      origin: "policy",
      status: "blocked",
      headline: `DENY · ${failed.length} of ${auth.checks.length} checks failed`,
      detail: failed.map((k) => label(k.rule)).join(" · "),
      anchor: "authorization-gate",
    };
  } else if (stale) {
    policy = {
      id: "policy",
      label: "Policy",
      origin: "policy",
      status: "blocked",
      headline: "Revalidation failed",
      detail: stale.detail,
      anchor: "authorization-gate",
    };
  } else {
    policy = {
      id: "policy",
      label: "Policy",
      origin: "policy",
      status: "done",
      headline: `${auth.outcome} · ${auth.checks.filter((k) => k.passed).length}/${auth.checks.length} checks passed`,
      detail: auth.action
        ? `Authorized ${formatMinor(auth.action.amountMinor, auth.action.currency)} on ${auth.action.transactionId} (amount from records)`
        : "No refund authorized",
      anchor: "authorization-gate",
    };
  }

  let execution: ProofStage;
  if (c.action) {
    execution = {
      id: "execution",
      label: "Simulated execution",
      origin: "execution",
      status: c.action.status === "ACCEPTED" ? "done" : "failed",
      headline: c.action.status === "ACCEPTED" ? "Gateway accepted (simulated)" : "Gateway error (simulated)",
      detail:
        c.action.status === "ACCEPTED"
          ? `Provider refund ${c.action.providerRefundId ?? "—"}`
          : (c.action.error ?? "No detail recorded"),
      anchor: "execution-panel",
    };
  } else if (auth) {
    execution = {
      id: "execution",
      label: "Simulated execution",
      origin: "execution",
      status: "skipped",
      headline: "Not executed · $0.00 dispatched",
      detail: auth.outcome === "APPROVE" ? "Stopped before execution" : `Execution gate locked (${auth.outcome})`,
      anchor: "execution-panel",
    };
  } else {
    execution = notRecorded("execution", "Simulated execution", "execution", undefined, "execution-panel");
  }

  let verification: ProofStage;
  if (c.verification) {
    verification = {
      id: "verification",
      label: "Verification",
      origin: "execution",
      status: c.verification.verified ? "done" : "failed",
      headline: c.verification.verified ? "Read-back confirmed" : "Read-back did NOT confirm",
      detail: c.verification.observedRefund
        ? `Observed ${formatMinor(c.verification.observedRefund.amountMinor, c.verification.observedRefund.currency)} (${c.verification.observedRefund.id})`
        : c.verification.detail,
      anchor: "verification-panel",
    };
  } else if (c.action) {
    verification = {
      id: "verification",
      label: "Verification",
      origin: "execution",
      status: "failed",
      headline: "No read-back recorded",
      detail: "Outcome uncertain — reconcile with the provider",
      anchor: "verification-panel",
    };
  } else {
    verification = {
      ...notRecorded("verification", "Verification", "execution", undefined, "verification-panel"),
      ...(auth ? { status: "skipped" as const, headline: "Nothing to verify", detail: "No refund was executed" } : {}),
    };
  }

  return [
    {
      id: "complaint",
      label: "Customer complaint",
      origin: "input",
      status: "done",
      headline: `${c.request.customerId} · order #${c.request.orderId}`,
      detail: c.request.message,
      anchor: "case-context",
    },
    understanding,
    evidence,
    proposal,
    policy,
    execution,
    verification,
  ];
}

function notRecorded(
  id: ProofStage["id"],
  stageLabel: string,
  origin: ProofOrigin,
  reason: { code: string; detail: string } | undefined,
  anchor: string,
): ProofStage {
  return reason
    ? { id, label: stageLabel, origin, status: "failed", headline: reason.code, detail: reason.detail, anchor }
    : { id, label: stageLabel, origin, status: "not-reached", headline: "Not reached", detail: "No record — the case ended earlier", anchor };
}

export interface DecisionExplanation {
  kind: "allowed" | "blocked" | "no-action" | "failed" | "in-progress";
  title: string;
  points: string[];
}

/** Why money did or did not move, in the engine's own recorded terms. */
export function explainDecision(c: Case): DecisionExplanation {
  const auth = c.authorization;
  if (c.state === "RESOLVED" && auth?.action && c.verification?.verified) {
    const passed = auth.checks.filter((k) => k.passed).length;
    return {
      kind: "allowed",
      title: "Why the refund was allowed",
      points: [
        `Amount ${formatMinor(auth.action.amountMinor, auth.action.currency)} was derived from the payment records — the model never chooses amounts`,
        `${passed} of ${auth.checks.length} deterministic policy checks passed`,
        `Read-back verification observed ${c.verification.observedRefund ? `refund ${c.verification.observedRefund.id}` : "the refund"} before the case closed`,
        "Payment gateway is simulated — no real money moved",
      ],
    };
  }
  if (c.state === "ESCALATED") {
    const failed = failedChecks(auth);
    const points = failed.length
      ? failed.map((k) => `${label(k.rule)} — ${k.detail}`)
      : c.reasons.map((r) => `${label(r.code)} — ${r.detail}`);
    if (c.proposal?.action === "REFUND_DUPLICATE") points.push("The AI proposed a refund; deterministic policy overrode it");
    points.push("$0.00 dispatched — routed to a human");
    return { kind: "blocked", title: "Why JARVIS refused to refund", points };
  }
  if (c.state === "CLOSED_NO_ACTION") {
    const points = ["Policy outcome NO_ACTION — no refund issued"];
    if (c.evidence?.financial.status === "PAID_EXACTLY_ONCE") {
      points.unshift(
        `Records show the order paid exactly once (net ${formatMinor(c.evidence.financial.netPaidMinor, c.evidence.order.currency)})`,
      );
    }
    points.push("$0.00 dispatched");
    return { kind: "no-action", title: "Why nothing was refunded", points };
  }
  if (c.state === "FAILED") {
    const points = c.reasons.map((r) => `${label(r.code)} — ${r.detail}`);
    if (c.verification && !c.verification.verified) points.push("Never marked RESOLVED: the refund could not be confirmed");
    else if (!c.action) points.push("$0.00 dispatched — no refund was attempted");
    return { kind: "failed", title: "Why the case failed safely", points };
  }
  return { kind: "in-progress", title: "Case not finished", points: [] };
}

export interface AuditLine {
  title: string;
  detail: string;
  origin: ProofOrigin | "system";
}

/** Human-readable line for one recorded audit event (no invented content). */
export function describeAuditEvent(ev: AuditEvent): AuditLine {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "STATE_TRANSITION":
      return { title: `${ev.from ?? "—"} → ${ev.to ?? "—"}`, detail: "", origin: "system" };
    case "UNDERSTANDING_CALL":
    case "MODEL_CALL": {
      const what = ev.type === "MODEL_CALL" ? "Decision call" : "Understanding call";
      const latency = typeof d.latencyMs === "number" ? ` · ${d.latencyMs} ms` : "";
      return {
        title: `${what} · ${String(d.adapter ?? "unknown adapter")}`,
        detail: d.error ? `error: ${String(d.error)}${latency}` : `output recorded${latency}`,
        origin: "ai",
      };
    }
    case "POLICY_EVALUATED": {
      const checks = Array.isArray(d.checks) ? (d.checks as { passed: boolean }[]) : [];
      const passed = checks.filter((k) => k.passed).length;
      return {
        title: d.revalidation ? "Pre-execution revalidation" : "Policy evaluated",
        detail: `${String(d.outcome ?? "—")} · ${passed}/${checks.length} checks passed`,
        origin: "policy",
      };
    }
    case "ACTION_ATTEMPTED":
      return {
        title: "Refund sent to simulated gateway",
        detail: `${String(d.status ?? "—")}${d.providerRefundId ? ` · ${String(d.providerRefundId)}` : ""}${d.error ? ` · ${String(d.error)}` : ""}`,
        origin: "execution",
      };
    case "VERIFICATION":
      return {
        title: "Read-back verification",
        detail: `${d.verified === true ? "verified" : "NOT verified"}${d.detail ? ` · ${String(d.detail)}` : ""}`,
        origin: "execution",
      };
    default:
      return { title: ev.type, detail: "", origin: "system" };
  }
}

export interface ShowdownRow {
  label: string;
  a: string;
  b: string;
}

/** Side-by-side facts for two real cases. */
export function showdownRows(a: Case, b: Case): ShowdownRow[] {
  const proposal = (c: Case) => c.proposal?.action.replaceAll("_", " ") ?? "none recorded";
  const policy = (c: Case) => c.authorization?.outcome ?? "not reached";
  const executed = (c: Case) =>
    c.action ? `${c.action.status} (simulated)` : "Not executed";
  const dispatched = (c: Case) =>
    c.verification?.observedRefund
      ? formatMinor(c.verification.observedRefund.amountMinor, c.verification.observedRefund.currency)
      : "$0.00";
  const verified = (c: Case) => (c.verification ? (c.verification.verified ? "Yes" : "No") : "Not applicable");
  return [
    { label: "AI proposal", a: proposal(a), b: proposal(b) },
    { label: "Policy outcome", a: policy(a), b: policy(b) },
    { label: "Refund executed", a: executed(a), b: executed(b) },
    { label: "Money observed moving", a: dispatched(a), b: dispatched(b) },
    { label: "Read-back verified", a: verified(a), b: verified(b) },
    { label: "Final state", a: a.state, b: b.state },
  ];
}

/**
 * Follows a proof-chain step to its record without touching the URL hash: the app's hash router
 * treats "#evidence-panel" as an unknown route and redirects to the dashboard. Scrolls to the panel
 * when it is on the page; otherwise asks the host (Judge Mode) to open the case where it is.
 */
export function followProofStep(
  anchor: string,
  find: (id: string) => { scrollIntoView(opts?: ScrollIntoViewOptions): void } | null,
  openElsewhere?: (anchor: string) => void,
): "scrolled" | "opened" | "none" {
  const target = find(anchor);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    return "scrolled";
  }
  if (openElsewhere) {
    openElsewhere(anchor);
    return "opened";
  }
  return "none";
}
