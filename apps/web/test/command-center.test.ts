import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoCase, failedVerificationCase, providerFailureCase, missingEvidenceCase } from './real-cases.ts';
import { canRunFixture, decisionJourney, missionOutcome, recordedInference } from '../src/lib/command-center.ts';
import { formatRoute, parseRoute } from '../src/lib/routes.ts';

test('Command Center route preserves case selection and existing Home route', () => {
  const route = { surface: 'merchant' as const, nav: 'command-center' as const, params: { case: 'CASE-123' } };
  assert.equal(formatRoute(route), '#/command-center?case=CASE-123');
  assert.deepEqual(parseRoute(formatRoute(route)), route);
  assert.deepEqual(parseRoute('#/dashboard'), { surface: 'merchant', nav: 'dashboard' });
});

test('authorized hero requires actual policy, action, and matching read-back evidence', async () => {
  const c = await demoCase('valid-duplicate');
  assert.equal(c.request.orderId, '48291');
  assert.equal(missionOutcome(c).title, 'Simulated action verified');
  assert.equal(recordedInference(c), 'Fixture demonstration');
  for (const changed of [
    { ...c, authorization: null }, { ...c, action: null }, { ...c, verification: null },
    { ...c, verification: { ...c.verification!, observedRefund: { ...c.verification!.observedRefund!, amountMinor: 1 } } },
  ]) assert.notEqual(missionOutcome(changed).tone, 'success');
});

test('unsafe hero is escalated with no action, while already-refunded hero stays closed', async () => {
  const blocked = await demoCase('prompt-injection');
  assert.equal(blocked.request.orderId, '48294');
  assert.equal(missionOutcome(blocked).title, 'No unsafe action executed');
  assert.equal(blocked.action, null);
  assert.equal(decisionJourney(blocked).find(s => s.id === 'policy')?.status, 'blocked');
  assert.equal(decisionJourney(blocked).find(s => s.id === 'escalate')?.status, 'done');
  const closed = await demoCase('already-refunded');
  assert.equal(closed.request.orderId, '48293');
  assert.equal(missionOutcome(closed).state, 'CLOSED_NO_ACTION');
  assert.equal(decisionJourney(closed).find(s => s.id === 'act')?.status, 'skipped');
});

test('incomplete and failed cases never gain imaginary evidence or success', async () => {
  for (const c of [await providerFailureCase(), await missingEvidenceCase(), await failedVerificationCase()]) {
    assert.notEqual(missionOutcome(c).tone, 'success');
    const stages = decisionJourney(c);
    if (!c.proposal) assert.equal(stages.find(s => s.id === 'reason')?.status, 'not-reached');
    if (!c.evidence) assert.notEqual(stages.find(s => s.id === 'retrieve')?.status, 'done');
  }
});

test('journey contains all canonical stages and does not invent missing audit records', async () => {
  const c = await demoCase('valid-duplicate');
  const before = JSON.stringify(c);
  assert.deepEqual(decisionJourney(c).map(s => s.id), ['input','understand','retrieve','reason','decide','policy','act','verify','escalate','audit']);
  assert.equal(decisionJourney({ ...c, audit: [] }).find(s => s.id === 'audit')?.status, 'not-reached');
  assert.equal(recordedInference({ ...c, audit: [] }), 'Inference provenance not confirmed');
  assert.equal(JSON.stringify(c), before);
});

test('current runtime cannot relabel past fixture records as live inference', async () => {
  const c = await demoCase('valid-duplicate');
  const liveAudit = c.audit.map(e => e.type === 'UNDERSTANDING_CALL' || e.type === 'MODEL_CALL' ? { ...e, data: { adapter: 'vllm:test-model' } } : e);
  assert.equal(recordedInference({ ...c, audit: liveAudit }), 'Recorded live inference');
  assert.equal(recordedInference(c), 'Fixture demonstration');
  const mixed = [...liveAudit, c.audit.find(e => e.type === 'MODEL_CALL')!];
  assert.equal(recordedInference({ ...c, audit: mixed }), 'Inference provenance not confirmed');
});

test('new runs require confirmed fixture mode and simulated payments, never live inference', () => {
  assert.equal(canRunFixture({ ok: true, aiMode: 'fixture', paymentGateway: 'simulated', remoteModel: false }), true);
  for (const health of [null, undefined, {}, { ok: false, aiMode: 'fixture', paymentGateway: 'simulated' },
    { ok: true, aiMode: 'vllm', paymentGateway: 'simulated' }, { ok: true, aiMode: 'fixture' },
    { ok: true, aiMode: 'fixture', paymentGateway: 'simulated', remoteModel: true }]) assert.equal(canRunFixture(health), false);
});
