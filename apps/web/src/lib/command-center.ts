import type { Case } from './case-types.ts';
import type { HealthPayload } from './runtime-truth.ts';
import { deriveProofChain, type ProofStatus } from './proof.ts';

export const HERO_ORDERS = ['48291', '48294', '48293', '48292'] as const;
export type JourneyGroup = 'investigation' | 'decision' | 'execution' | 'proof';
export type JourneyId = 'input' | 'understand' | 'retrieve' | 'reason' | 'decide' | 'policy' | 'act' | 'verify' | 'escalate' | 'audit';
export interface JourneyStage {
  id: JourneyId;
  group: JourneyGroup;
  label: string;
  status: ProofStatus;
  summary: string;
  detail: string;
}

/** Display only. All authority remains in the existing server pipeline. */
export function decisionJourney(c: Case): JourneyStage[] {
  const proof = deriveProofChain(c);
  const from = (id: JourneyId, group: JourneyGroup, label: string, source: number): JourneyStage => ({
    id, group, label, status: proof[source].status, summary: proof[source].headline, detail: proof[source].detail,
  });
  const escalated = c.state === 'ESCALATED';
  return [
    from('input', 'investigation', 'Input', 0),
    from('understand', 'investigation', 'Understand', 1),
    from('retrieve', 'investigation', 'Retrieve', 2),
    { id: 'reason', group: 'decision', label: 'Reason', status: c.proposal ? 'done' : 'not-reached',
      summary: c.proposal ? 'Recorded decision summary' : 'No summary recorded',
      detail: c.proposal?.rationale || 'Not available. Internal model reasoning is not exposed.' },
    from('decide', 'decision', 'Decide', 3),
    from('policy', 'decision', 'Policy', 4),
    from('act', 'execution', 'Act', 5),
    from('verify', 'proof', 'Verify', 6),
    { id: 'escalate', group: 'execution', label: 'Escalate',
      status: escalated ? 'done' : c.state === 'FAILED' ? 'failed' : c.state === 'RESOLVED' || c.state === 'CLOSED_NO_ACTION' ? 'skipped' : 'not-reached',
      summary: escalated ? 'Human review required' : c.state === 'FAILED' ? 'Could not complete safely' : 'No escalation recorded',
      detail: escalated || c.state === 'FAILED' ? 'Review the recorded reasons. This demo has no human approve/reject execution endpoint.' : 'No human handoff is recorded for this case.' },
    { id: 'audit', group: 'proof', label: 'Audit', status: c.audit.length ? 'done' : 'not-reached',
      summary: c.audit.length ? `${c.audit.length} recorded events` : 'No audit data recorded',
      detail: 'Event order and timestamps come from the returned case. This replay does not generate new events.' },
  ];
}

/** A past case's provenance must not be inferred from today's runtime. */
export function recordedInference(c: Case): string {
  const calls = c.audit.filter(e => e.type === 'UNDERSTANDING_CALL' || e.type === 'MODEL_CALL');
  const adapters = calls.map(e => {
    const data = e.data as { adapter?: unknown; error?: unknown } | null;
    return { adapter: typeof data?.adapter === 'string' ? data.adapter : '', failed: Boolean(data?.error) };
  });
  if (adapters.length && adapters.every(a => a.adapter.startsWith('fixture-'))) return 'Fixture demonstration';
  if (adapters.length >= 2 && adapters.every(a => a.adapter.startsWith('vllm:') && !a.failed)) return 'Recorded live inference';
  return 'Inference provenance not confirmed';
}

export function canRunFixture(health: HealthPayload | null | undefined): boolean {
  return health?.ok === true && health.aiMode === 'fixture' && health.paymentGateway === 'simulated' && health.remoteModel !== true;
}

/** Stronger than a terminal-state label: never present an unverified action as success. */
export function missionOutcome(c: Case) {
  const action = c.authorization?.action;
  const observed = c.verification?.observedRefund;
  const verified = c.state === 'RESOLVED' && c.authorization?.outcome === 'APPROVE' &&
    c.action?.status === 'ACCEPTED' && c.verification?.verified === true && action && observed &&
    observed.amountMinor === action.amountMinor && observed.currency === action.currency &&
    observed.transactionId === action.transactionId;
  if (verified) return { tone: 'success', title: 'Simulated action verified', state: 'RESOLVED',
    detail: 'Authorized by policy. Confirmed by read-back. No real money moved.' };
  if (c.state === 'ESCALATED' && !c.action) return { tone: 'review', title: 'No unsafe action executed', state: 'ESCALATED',
    detail: 'Automatic execution stopped. A person must review the evidence.' };
  if (c.state === 'CLOSED_NO_ACTION' && !c.action) return { tone: 'neutral', title: 'No further action needed', state: 'CLOSED_NO_ACTION',
    detail: 'The recorded decision required no new refund.' };
  if (c.state === 'CLOSED_NO_ACTION' && c.action?.replayed === true && c.verification?.verified === true)
    return { tone: 'neutral', title: 'Refund already executed', state: 'CLOSED_NO_ACTION',
      detail: `Another request executed ${c.action.providerRefundId ?? 'this refund'} first; read-back confirms it. This case moved no money.` };
  return { tone: c.state === 'FAILED' || c.state === 'RESOLVED' ? 'error' : 'neutral',
    title: c.action ? 'Action not confirmed as resolved' : 'No verified action recorded', state: c.state,
    detail: 'Inspect the available records. A terminal label alone does not prove a successful refund.' };
}

export function recordTime(value: string): string {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' UTC' : 'Time not available';
}
