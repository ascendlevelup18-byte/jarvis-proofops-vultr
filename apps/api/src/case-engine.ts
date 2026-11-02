// Runs one case from RECEIVED to a terminal state. Linear and bounded: one
// understanding call, one model call, at most one refund call, one read-back.
// Every transition is audited.
import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  Case,
  CaseRequest,
  CaseState,
  Reason,
  RefundAction,
  RefundPolicy,
} from "./contracts.ts";
import { gatherEvidence } from "./evidence.ts";
import type { CommerceStore } from "./fixtures.ts";
import type { PaymentGateway } from "./gateway.ts";
import { buildModelInput, parseProposal, type ModelAdapter } from "./model-adapter.ts";
import { authorize, type Permissions } from "./policy-engine.ts";
import { parseStructuredRequest, type RequestUnderstandingAdapter } from "./request-understanding.ts";
import { assertTransition, isTerminal } from "./state-machine.ts";

export interface EngineDeps {
  store: CommerceStore;
  gateway: PaymentGateway;
  understanding: RequestUnderstandingAdapter;
  model: ModelAdapter;
  policy: RefundPolicy;
  permissions: Permissions;
  clock: () => Date;
  modelTimeoutMs: number;
}

const MAX_AUDITED_MODEL_OUTPUT = 4000;

export async function runCase(request: CaseRequest, deps: EngineDeps): Promise<Case> {
  const now = deps.clock().toISOString();
  const c: Case = {
    id: `CASE-${randomUUID()}`,
    request,
    state: "RECEIVED",
    createdAt: now,
    updatedAt: now,
    understanding: null,
    evidence: null,
    proposal: null,
    authorization: null,
    action: null,
    verification: null,
    reasons: [],
    audit: [],
  };
  audit(c, deps, "STATE_TRANSITION", null, "RECEIVED", { request });

  try {
    await advance(c, deps);
  } catch (e) {
    // Unexpected error: never leave a case mid-flight.
    if (!isTerminal(c.state)) finish(c, deps, "FAILED", [{ code: "INTERNAL_ERROR", detail: message(e) }]);
  }
  return c;
}

async function advance(c: Case, deps: EngineDeps): Promise<void> {
  move(c, deps, "EXTRACTING");
  const understood = await boundedCall(c, deps, "UNDERSTANDING", deps.understanding.id, (signal) =>
    deps.understanding.understand({ untrusted: { customerMessage: c.request.message } }, signal),
  );
  if (!understood.ok) return finish(c, deps, "FAILED", [understood.reason]);
  const request = parseStructuredRequest(understood.raw);
  if (!request.ok) return finish(c, deps, "FAILED", [{ code: "UNDERSTANDING_OUTPUT_INVALID", detail: request.error }]);
  c.understanding = request.value;

  move(c, deps, "EVIDENCE_GATHERING", { understanding: c.understanding });
  const gathered = gatherEvidence(c.request, c.understanding, deps.store, deps.policy);
  if (!gathered.ok) return finish(c, deps, "ESCALATED", [gathered.reason]);
  c.evidence = gathered.evidence;

  move(c, deps, "ANALYZING", {
    orderId: c.evidence.order.id,
    transactionIds: c.evidence.transactions.map((t) => t.id),
    duplicateGroups: c.evidence.duplicateGroups,
    financial: c.evidence.financial,
    contradictions: c.evidence.contradictions,
  });
  const input = buildModelInput(c.id, c.request.message, c.evidence);
  const model = await boundedCall(c, deps, "MODEL", deps.model.id, (signal) => deps.model.propose(input, signal));
  if (!model.ok) return finish(c, deps, "FAILED", [model.reason]);
  const parsed = parseProposal(model.raw);
  if (!parsed.ok) return finish(c, deps, "FAILED", [{ code: "MODEL_OUTPUT_INVALID", detail: parsed.error }]);
  c.proposal = parsed.value;

  move(c, deps, "DECISION_PROPOSED", { proposal: c.proposal });
  move(c, deps, "POLICY_VALIDATION");
  c.authorization = authorize(c.proposal, c.evidence, c.request, deps.permissions);
  audit(c, deps, "POLICY_EVALUATED", null, null, c.authorization);

  if (c.authorization.outcome === "DENY") {
    const failed = c.authorization.checks.filter((k) => !k.passed);
    return finish(
      c,
      deps,
      "ESCALATED",
      failed.map((k) => ({ code: "POLICY_DENIED", detail: `${k.rule}: ${k.detail}` })),
    );
  }
  if (c.authorization.outcome === "NO_ACTION") return finish(c, deps, "CLOSED_NO_ACTION", []);
  const action = c.authorization.action!;
  move(c, deps, "APPROVED", { action });

  // Stale-state guard: re-read records and re-authorize immediately before acting.
  // Nothing async runs between this check and the refund call.
  const stale = revalidate(c, deps, action);
  if (stale.length > 0) return finish(c, deps, "ESCALATED", stale);

  move(c, deps, "EXECUTING", { action });
  try {
    const { refundId, replayed = false } = await deps.gateway.refund(action);
    c.action = { status: "ACCEPTED", providerRefundId: refundId, replayed, error: null, attemptedAt: deps.clock().toISOString() };
  } catch (e) {
    // An error does not prove nothing happened; verification decides.
    c.action = { status: "ERROR", providerRefundId: null, error: message(e), attemptedAt: deps.clock().toISOString() };
  }
  audit(c, deps, "ACTION_ATTEMPTED", null, null, c.action);

  move(c, deps, "VERIFYING");
  let detail: string;
  let observed = null;
  try {
    observed = await deps.gateway.findRefund(action.idempotencyKey);
    detail = !observed
      ? "no refund found at provider"
      : observed.status !== "SUCCEEDED"
        ? `refund status ${observed.status}`
        : observed.transactionId !== action.transactionId ||
            observed.amountMinor !== action.amountMinor ||
            observed.currency !== action.currency
          ? "provider refund does not match the authorized action"
          : c.action.providerRefundId !== null && observed.id !== c.action.providerRefundId
            ? `read-back found refund ${observed.id}, not the ${c.action.providerRefundId} the gateway returned`
            : "provider confirms refund matches the authorized action";
  } catch (e) {
    detail = `read-back failed: ${message(e)}`;
  }
  const verified = detail.startsWith("provider confirms");
  c.verification = { verified, observedRefund: observed, detail };
  audit(c, deps, "VERIFICATION", null, null, c.verification);
  if (!verified) return finish(c, deps, "FAILED", [{ code: "EXECUTION_NOT_VERIFIED", detail }]);
  // Another case executed this refund first (same idempotency key). The duplicate is refunded and
  // verified, but this case moved no money, so it must not count as a second resolution.
  if (c.action.replayed) {
    return finish(c, deps, "CLOSED_NO_ACTION", [
      { code: "REFUND_ALREADY_EXECUTED", detail: `refund ${observed!.id} already existed for ${action.idempotencyKey}; this case created no new refund` },
    ]);
  }
  move(c, deps, "RESOLVED");
}

function revalidate(c: Case, deps: EngineDeps, action: RefundAction): Reason[] {
  const fresh = gatherEvidence(c.request, c.understanding!, deps.store, deps.policy);
  if (!fresh.ok) return [{ code: "STALE_EVIDENCE", detail: `evidence no longer available: ${fresh.reason.detail}` }];
  const again = authorize(c.proposal!, fresh.evidence, c.request, deps.permissions);
  audit(c, deps, "POLICY_EVALUATED", null, null, { revalidation: true, ...again });
  if (again.outcome !== "APPROVE") {
    return again.checks
      .filter((k) => !k.passed)
      .map((k) => ({ code: "STALE_EVIDENCE", detail: `${k.rule}: ${k.detail}` }));
  }
  const a = again.action!;
  if (a.transactionId !== action.transactionId || a.amountMinor !== action.amountMinor || a.currency !== action.currency) {
    return [{ code: "STALE_EVIDENCE", detail: "authorized action differs on current records" }];
  }
  return [];
}

const STAGES = {
  UNDERSTANDING: { audit: "UNDERSTANDING_CALL", timeout: "UNDERSTANDING_TIMEOUT", error: "UNDERSTANDING_ERROR" },
  MODEL: { audit: "MODEL_CALL", timeout: "MODEL_TIMEOUT", error: "MODEL_ERROR" },
} as const;

// Calls an untrusted adapter with a hard timeout and audits the raw result.
async function boundedCall(
  c: Case,
  deps: EngineDeps,
  stage: keyof typeof STAGES,
  adapterId: string,
  call: (signal: AbortSignal) => Promise<string>,
): Promise<{ ok: true; raw: unknown } | { ok: false; reason: Reason }> {
  const s = STAGES[stage];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AdapterTimeoutError(adapterId, deps.modelTimeoutMs));
    }, deps.modelTimeoutMs);
  });
  const started = performance.now();
  try {
    // Race so a misbehaving adapter that ignores the signal still cannot hang the case.
    const raw: unknown = await Promise.race([call(controller.signal), timeout]);
    audit(c, deps, s.audit, null, null, {
      adapter: adapterId,
      latencyMs: Math.round(performance.now() - started),
      output: typeof raw === "string" ? raw.slice(0, MAX_AUDITED_MODEL_OUTPUT) : raw,
    });
    return { ok: true, raw };
  } catch (e) {
    audit(c, deps, s.audit, null, null, {
      adapter: adapterId,
      latencyMs: Math.round(performance.now() - started),
      error: message(e),
    });
    return { ok: false, reason: { code: e instanceof AdapterTimeoutError ? s.timeout : s.error, detail: message(e) } };
  } finally {
    clearTimeout(timer);
  }
}

class AdapterTimeoutError extends Error {
  constructor(adapterId: string, ms: number) {
    super(`${adapterId} did not respond within ${ms}ms`);
  }
}

function move(c: Case, deps: EngineDeps, to: CaseState, data: unknown = {}): void {
  assertTransition(c, to);
  const from = c.state;
  c.state = to;
  c.updatedAt = deps.clock().toISOString();
  audit(c, deps, "STATE_TRANSITION", from, to, data);
}

function finish(c: Case, deps: EngineDeps, to: "ESCALATED" | "FAILED" | "CLOSED_NO_ACTION", reasons: Reason[]): void {
  c.reasons = reasons;
  move(c, deps, to, { reasons });
}

function audit(
  c: Case,
  deps: EngineDeps,
  type: AuditEvent["type"],
  from: CaseState | null,
  to: CaseState | null,
  data: unknown,
): void {
  c.audit.push({
    seq: c.audit.length + 1,
    caseId: c.id,
    at: deps.clock().toISOString(),
    type,
    from,
    to,
    data: structuredClone(data),
  });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
