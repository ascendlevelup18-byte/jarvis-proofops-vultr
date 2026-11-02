import type { Case } from '../../lib/case-types.ts';
import { decisionJourney, recordTime, type JourneyGroup, type JourneyStage } from '../../lib/command-center.ts';
import { describeAuditEvent } from '../../lib/proof.ts';
import { formatMinor } from '../../lib/money.ts';
import { Icon } from '../ui/Icon.tsx';

const GROUPS: { id: JourneyGroup; label: string; description: string }[] = [
  { id: 'investigation', label: 'Investigation', description: 'Input · understand · retrieve' },
  { id: 'decision', label: 'Decision', description: 'Reason · decide · policy' },
  { id: 'execution', label: 'Execution', description: 'Act · escalate' },
  { id: 'proof', label: 'Proof', description: 'Verify · audit' },
];
const STATUS = { done: 'Recorded', blocked: 'Blocked', failed: 'Failed', skipped: 'Not needed / skipped', 'not-reached': 'Not recorded' };
const readable = (s: string) => s.replaceAll('_', ' ').toLowerCase();


export function DecisionReveal({ caseData, group, onGroup }: { caseData: Case; group: JourneyGroup; onGroup: (g: JourneyGroup) => void }) {
  const stages = decisionJourney(caseData);
  return <section className="cc-intelligence" aria-labelledby="cc-intelligence-title">
    <header className="cc-section-heading"><div><p className="cc-kicker">DECISION INTELLIGENCE</p><h3 id="cc-intelligence-title">Follow the evidence.</h3></div><span className="cc-replay"><Icon name="activity" size={15}/> Recorded decision replay</span></header>
    <div className="cc-reveal-layout">
      <nav className="cc-group-nav" aria-label="Decision lifecycle">
        {GROUPS.map((g, i) => <button key={g.id} type="button" aria-pressed={group === g.id} onClick={() => onGroup(g.id)} aria-controls="cc-stage-content"><span className="cc-group-number">0{i + 1}</span><span><strong>{g.label}</strong><small>{g.description}</small></span><Icon name="chevron" size={15}/></button>)}
      </nav>
      <div id="cc-stage-content" className="cc-stage-content" key={`${caseData.id}-${group}`}>
        <div className="cc-stage-intro"><h4>{GROUPS.find(g => g.id === group)?.label}</h4><p>{group === 'decision' ? 'Recorded summaries and policy checks. Internal model reasoning is not exposed.' : group === 'proof' ? 'Verification and audit are separate records. Neither is inferred from an animation.' : group === 'execution' ? 'An AI suggestion is not permission to act.' : 'The customer request and the records used to assess it.'}</p></div>
        {stages.filter(s => s.group === group).map((stage, i) => <details className="cc-stage" key={stage.id} open={i === 0 || stage.id === 'policy' || stage.id === 'verify' || stage.id === 'audit'}>
          <summary><span className={`cc-stage-dot cc-stage-${stage.status}`}/><span><strong>{stage.label}</strong><small>{stage.summary}</small></span><span className={`cc-stage-status cc-stage-${stage.status}`}>{STATUS[stage.status]}</span><Icon name="chevron" size={16}/></summary>
          <div className="cc-stage-record"><StageRecord stage={stage} c={caseData}/></div>
        </details>)}
      </div>
    </div>
  </section>;
}

function StageRecord({ stage, c }: { stage: JourneyStage; c: Case }) {
  const ev = c.evidence;
  switch (stage.id) {
    case 'input': return <><p className="cc-record-label">CUSTOMER MESSAGE · TREATED AS UNTRUSTED INPUT</p><blockquote>{c.request.message}</blockquote><dl className="cc-facts"><div><dt>Customer</dt><dd>{ev?.customer.name ?? c.request.customerId}</dd></div><div><dt>Order</dt><dd>#{c.request.orderId}</dd></div><div><dt>Received</dt><dd>{recordTime(c.createdAt)}</dd></div></dl></>;
    case 'understand': return c.understanding ? <><p>{readable(c.understanding.intent)}</p><p className="cc-muted">{c.understanding.mentionedAmounts.length ? `Amounts stated in the message: ${c.understanding.mentionedAmounts.map(m => m.text).join(', ')}. These are claims, not authorized amounts.` : 'No amount was stated in the message.'}</p></> : <p>{stage.detail}</p>;
    case 'retrieve': return ev ? <><dl className="cc-facts"><div><dt>Order total</dt><dd>{formatMinor(ev.order.totalMinor, ev.order.currency)}</dd></div><div><dt>Net paid before review</dt><dd>{formatMinor(ev.financial.netPaidMinor, ev.order.currency)}</dd></div><div><dt>Payment state</dt><dd>{readable(ev.financial.status)}</dd></div></dl><div className="cc-table-scroll"><table><caption>Payment records available to this decision</caption><thead><tr><th>Charge</th><th>Amount</th><th>Already refunded</th><th>Status</th></tr></thead><tbody>{ev.transactions.map(t => <tr key={t.id}><th scope="row">{t.id}</th><td>{formatMinor(t.amountMinor, t.currency)}</td><td>{formatMinor(t.refundedMinor, t.currency)}</td><td>{t.status}</td></tr>)}</tbody></table></div>{ev.transactions.length === 0 && <p>No payment records available.</p>}{ev.contradictions.length > 0 && <div className="cc-notice cc-error"><strong>Conflicting evidence</strong><ul>{ev.contradictions.map((v, i) => <li key={i}>{v}</li>)}</ul></div>}<details className="cc-small-details"><summary>Evidence references and prior refunds</summary><p>{ev.sourceIds.join(' · ') || 'No source references recorded.'}</p>{ev.refunds.map(r => <p key={r.id}>{r.id} · {formatMinor(r.amountMinor, r.currency)} · {r.status}</p>)}</details></> : <p>No evidence bundle is available. {stage.detail}</p>;
    case 'reason': return <><p>{stage.detail}</p><p className="cc-muted">This is the model’s recorded decision summary, not hidden chain-of-thought or a new AI response.</p></>;
    case 'decide': return c.proposal ? <><dl className="cc-facts"><div><dt>Suggested action</dt><dd>{readable(c.proposal.action)}</dd></div><div><dt>Confidence (advisory)</dt><dd>{Math.round(c.proposal.confidence * 100)}% · grants no authority</dd></div><div><dt>Risk flags</dt><dd>{c.proposal.riskFlags.join(', ') || 'None recorded'}</dd></div></dl><p className="cc-muted">Cited evidence: {c.proposal.evidenceRefs.join(' · ') || 'None recorded'}</p></> : <p>{stage.detail}</p>;
    case 'policy': return c.authorization ? <><div className={`cc-policy-verdict ${c.authorization.outcome === 'DENY' ? 'cc-denied' : ''}`}><Icon name="shield" size={22}/><div><strong>{c.authorization.outcome === 'APPROVE' ? 'Action authorized by policy' : c.authorization.outcome === 'DENY' ? 'Automatic action denied' : 'No refund authorized'}</strong><p>{stage.detail}</p></div></div><details className="cc-small-details"><summary>Inspect {c.authorization.checks.length} policy checks · {c.authorization.checks.filter(check => !check.passed).length} failed</summary><ul className="cc-checks">{c.authorization.checks.map((check, i) => <li key={`${check.rule}-${i}`}><span className={check.passed ? 'cc-pass' : 'cc-fail'}>{check.passed ? 'Pass' : 'Fail'}</span><div><strong>{readable(check.rule)}</strong><p>{check.detail}</p></div></li>)}</ul></details>{ev?.policy && <details className="cc-small-details"><summary>Applicable policy · {ev.policy.id} v{ev.policy.version}</summary>{ev.policy.sections.map(s => <p key={s.id}><b>{s.id}</b> — {s.text}</p>)}</details>}</> : <p>No authorization decision is available. No permission is inferred.</p>;
    case 'act': return <><p>{stage.detail}</p>{c.action ? <dl className="cc-facts"><div><dt>Simulated gateway</dt><dd>{c.action.status}</dd></div><div><dt>Provider reference</dt><dd>{c.action.providerRefundId ?? 'Not available'}</dd></div><div><dt>Attempted</dt><dd>{recordTime(c.action.attemptedAt)}</dd></div>{c.action.error && <div><dt>Error</dt><dd>{c.action.error}</dd></div>}</dl> : <p className="cc-muted">No action result is recorded. No real money moves in this demo.</p>}</>;
    case 'verify': return c.verification ? <><p className={c.verification.verified ? 'cc-pass' : 'cc-fail'}>{c.verification.verified ? 'Read-back verified by the backend' : 'Read-back did not confirm the outcome'}</p><p>{c.verification.detail}</p>{c.verification.observedRefund ? <dl className="cc-facts"><div><dt>Observed simulated refund</dt><dd>{formatMinor(c.verification.observedRefund.amountMinor, c.verification.observedRefund.currency)}</dd></div><div><dt>Refund reference</dt><dd>{c.verification.observedRefund.id}</dd></div><div><dt>Charge reference</dt><dd>{c.verification.observedRefund.transactionId}</dd></div></dl> : <p>No observed refund record is available.</p>}</> : <p>{stage.detail}</p>;
    case 'escalate': return <><p>{stage.detail}</p>{c.reasons.length ? <ul className="cc-reasons">{c.reasons.map((r, i) => <li key={i}><strong>{readable(r.code)}</strong><p>{r.detail}</p></li>)}</ul> : <p className="cc-muted">No additional reasons recorded.</p>}</>;
    case 'audit': return c.audit.length ? <ol className="cc-audit">{c.audit.map((event, i) => { const line = describeAuditEvent(event); return <li key={`${event.seq}-${i}`}><span className="cc-audit-seq">{event.seq}</span><div><strong>{line.title}</strong>{line.detail && <p>{line.detail}</p>}<time dateTime={event.at}>{recordTime(event.at)}</time></div></li>; })}</ol> : <p>No audit events are available. The interface will not invent them.</p>;
  }
}
