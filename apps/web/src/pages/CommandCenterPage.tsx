import { useEffect, useMemo, useRef, useState } from 'react';
import type { Case } from '../lib/case-types.ts';
import { CaseSchema } from '../lib/case-schema.ts';
import type { SessionCaseEntry } from '../lib/session-store.ts';
import type { DemoStoreOrder, DemoStoreSnapshot } from '../lib/demo-store.ts';
import type { HealthPayload } from '../lib/runtime-truth.ts';
import type { StoreLoad } from './OrdersPage.tsx';
import { HERO_ORDERS, recordTime, canRunFixture, missionOutcome, recordedInference, type JourneyGroup } from '../lib/command-center.ts';
import { explainDecision } from '../lib/proof.ts';
import { DecisionReveal } from '../components/command/DecisionReveal.tsx';
import { Icon } from '../components/ui/Icon.tsx';
import './command-center.css';

interface Props {
  history: SessionCaseEntry[];
  snapshot: DemoStoreSnapshot | null;
  load: StoreLoad;
  selectedId?: string;
  onSelect: (id: string) => void;
  onRunOrder: (order: DemoStoreOrder) => Promise<Case>;
  onOpenCase: (id: string) => void;
  onReview: () => void;
  onReload: () => void;
}

async function readHealth(): Promise<HealthPayload | null> {
  try {
    const response = await fetch('/api/health', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    return response.ok ? await response.json() as HealthPayload : null;
  } catch { return null; }
}

export function CommandCenterPage(props: Props) {
  const { history, snapshot, selectedId, onSelect, onRunOrder, onOpenCase } = props;
  const [health, setHealth] = useState<HealthPayload | null | undefined>();
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<JourneyGroup>('investigation');
  const pending = useRef(false);
  const proof = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const records = useMemo(() => history.filter(h => CaseSchema.safeParse(h.caseData).success), [history]);
  const defaultRecord = records.find(h => h.orderId === '48291') ?? records[0];
  const key = selectedId ?? defaultRecord?.id ?? 'order:48291';
  const entry = records.find(h => h.id === key);
  const c = entry?.caseData ?? null;
  const orderId = c?.request.orderId ?? (key.startsWith('order:') ? key.slice(6) : null);
  const order = snapshot?.orders.find(o => o.orderId === orderId);
  const pendingCount = records.filter(h => h.state === 'ESCALATED' || h.state === 'FAILED').length;
  const outcome = c ? missionOutcome(c) : null;
  const apiOk = health?.ok === true;
  const fixtureReady = canRunFixture(health);

  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      const result = await readHealth();
      if (!cancelled) { setHealth(result); setCheckedAt(new Date().toISOString()); }
    };
    void update();
    const interval = window.setInterval(() => void update(), 30000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => setSlow(true), 10000);
    return () => window.clearTimeout(timer);
  }, [busy]);

  const select = (id: string) => {
    if (pending.current) return;
    setConfirm(false); setError(null); setSlow(false); setGroup('investigation'); onSelect(id);
    workspace.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    workspace.current?.focus({ preventScroll: true });
  };
  const inspect = (next: JourneyGroup) => {
    setGroup(next);
    proof.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    proof.current?.focus({ preventScroll: true });
  };
  const refresh = async () => {
    if (checking) return;
    setChecking(true);
    const h = await readHealth();
    setHealth(h); setCheckedAt(new Date().toISOString()); setChecking(false);
  };
  const run = async () => {
    if (!order || pending.current) return;
    pending.current = true; setBusy(true); setSlow(false); setError(null);
    try {
      // Recheck immediately before POST; a recorded case never proves current fixture mode.
      const h = await readHealth(); setHealth(h); setCheckedAt(new Date().toISOString());
      if (!canRunFixture(h)) throw new Error('Fixture mode and simulated payments could not be confirmed. No new case was submitted. Recorded evidence remains available.');
      const result = await onRunOrder(order);
      setConfirm(false); setGroup('decision'); onSelect(result.id);
      workspace.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      workspace.current?.focus({ preventScroll: true });
    } catch (e) { setError(e instanceof Error ? e.message : 'The server did not confirm a result. Check recorded cases before trying again.'); }
    finally { pending.current = false; setBusy(false); }
  };
  const hero = (id: string) => records.find(h => h.orderId === id)?.id ?? `order:${id}`;

  return <div className="cc-page">
    <header className="cc-header">
      <div className="cc-wordmark"><span className="cc-command-mark"><Icon name="shield" size={22}/></span><span>JARVIS <span>/</span> OPERATIONS</span><span className="cc-edition">ACT III</span></div>
      <div className="cc-heading"><div><p className="cc-kicker">THE HUMAN SIDE OF AUTONOMY</p><h2>JARVIS Command Center<span>.</span></h2><p className="cc-subtitle">Intelligence with evidence. Actions with accountability.</p></div><span className="cc-header-emblem" aria-hidden="true"><Icon name="spark" size={48}/></span></div>
      <div className="cc-status-row" aria-label="Command Center runtime status">
        <span className={`cc-runtime ${apiOk ? 'cc-online' : ''}`}><i/>{health === undefined ? 'Checking API…' : apiOk ? 'API connected' : 'API unavailable or degraded'}</span>
        <span>{fixtureReady ? 'Fixture runtime · no remote inference' : health?.aiMode === 'fixture' ? 'Fixture mode reported · run conditions not confirmed' : health?.aiMode === 'vllm' ? 'Live runtime configured · demo runs disabled here' : 'Runtime not confirmed'}</span>
        <span>Payments simulated</span><button type="button" onClick={props.onReview}>{pendingCount} {pendingCount === 1 ? 'case needs' : 'cases need'} review <Icon name="arrow" size={13}/></button>
        <button className="cc-refresh" type="button" onClick={() => void refresh()} disabled={checking}>{checking ? 'Checking…' : 'Check connection'}</button>
      </div>
      {checkedAt && <p className="cc-health-time">Connection checked {recordTime(checkedAt)} · refreshes every 30 seconds</p>}
    </header>

    <div ref={workspace} tabIndex={-1} className="cc-case-toolbar" aria-label="Selected case workspace"><div><p className="cc-kicker">MISSION WORKSPACE</p><h3>One case. Every check.</h3></div><label className="cc-case-select">Focused case<select value={key} disabled={busy} onChange={e => select(e.target.value)}><optgroup label="Recorded cases">{records.map(h => <option key={h.id} value={h.id}>Order #{h.orderId} · {h.state} · {recordTime(h.submittedAt)}</option>)}</optgroup><optgroup label="Create a new fixture record">{HERO_ORDERS.map(id => <option key={id} value={`order:${id}`}>Order #{id} · saved demo request</option>)}</optgroup>{selectedId && !entry && !(HERO_ORDERS as readonly string[]).some(id => key === `order:${id}`) && <option value={selectedId}>Case not found</option>}</select></label></div>

    {c && outcome ? <>
      <section className={`cc-mission cc-outcome-${outcome.tone}`} key={c.id} aria-labelledby="cc-mission-title">
        <div className="cc-mission-main"><div className="cc-provenance"><span><Icon name="activity" size={13}/> Recorded decision replay</span><span>{recordedInference(c)}</span></div><p className="cc-order-label">ORDER #{c.request.orderId} <span>·</span> {c.evidence?.customer.name ?? c.request.customerId}</p><h3 id="cc-mission-title">{outcome.tone === 'success' ? 'A duplicate charge.\nA controlled resolution.' : outcome.tone === 'review' ? 'This needs a person.\nJARVIS stopped.' : outcome.state === 'CLOSED_NO_ACTION' ? 'Already settled.\nNo redundant refund.' : 'A decision worth\na closer look.'}</h3><p className="cc-case-summary">{explainDecision(c).points[0] ?? 'Inspect the available records to understand this decision.'}</p><div className="cc-mission-actions"><button type="button" className="cc-primary" onClick={() => inspect('decision')}>Inspect decision <Icon name="arrow" size={16}/></button><button type="button" className="cc-secondary" onClick={() => inspect('investigation')}>View evidence <Icon name="orders" size={16}/></button></div><p className="cc-case-id">{c.id} · recorded {recordTime(c.updatedAt)}</p></div>
        <div className="cc-outcome-panel" aria-live="polite"><span className="cc-outcome-icon"><Icon name={outcome.tone === 'success' ? 'shield' : outcome.tone === 'review' ? 'shield' : 'activity'} size={35}/></span><p className="cc-kicker">RECORDED OUTCOME</p><p className="cc-outcome-state">{outcome.state}</p><h4>{outcome.title}</h4><p>{outcome.detail}</p><div className="cc-outcome-facts"><span><b>Policy</b>{c.authorization?.outcome ?? 'Not available'}</span><span><b>Verification</b>{c.verification?.verified ? 'Read-back confirmed' : c.verification ? 'Not confirmed' : 'Not performed'}</span></div>{outcome.tone === 'review' && <button type="button" className="cc-review-link" onClick={props.onReview}>Open review queue <Icon name="arrow" size={14}/></button>}</div>
      </section>
      <div className="cc-guided" aria-label="Guided commands"><span><Icon name="spark" size={16}/> Guided inspection</span><button type="button" onClick={() => select(hero('48291'))} disabled={busy}>Investigate duplicate charge</button><button type="button" onClick={() => select(hero('48294'))} disabled={busy}>Show blocked refund</button><button type="button" onClick={() => inspect('decision')}>Explain policy decision</button><button type="button" onClick={() => inspect('proof')}>Open audit trail</button></div>
      <div ref={proof} tabIndex={-1} className="cc-proof-target"><DecisionReveal caseData={c} group={group} onGroup={setGroup}/></div>
      <footer className="cc-footer"><p><Icon name="shield" size={16}/> AI proposes. Policy controls. Records prove.</p><button type="button" onClick={() => onOpenCase(c.id)}>Open full case details <Icon name="arrow" size={15}/></button></footer>
    </> : <section className="cc-empty-mission" aria-live="polite">
      <span className="cc-empty-icon"><Icon name="shield" size={34}/></span><p className="cc-kicker">{orderId ? `ORDER #${orderId}` : 'RECORDED CASE'}</p><h3>{selectedId && !entry && !key.startsWith('order:') ? 'This case isn’t recorded here.' : 'Start with a real decision record.'}</h3><p>No outcome is assumed. Select a recorded case or create a fixture demonstration through the existing guarded workflow.</p>
      {props.load.status === 'loading' && !order && <p role="status">Loading demo requests…</p>}
      {props.load.status === 'error' && !order && <div className="cc-notice cc-error" role="alert"><strong>Demo requests could not load.</strong><p>{props.load.error}</p><button type="button" className="cc-secondary" onClick={props.onReload}>Retry demo store</button></div>}
      {order && <div className="cc-demo-preview"><p className="cc-record-label">SAVED DEMO REQUEST · {order.customerName}</p><blockquote>{order.supportRequest.message}</blockquote><p>Fixture demonstration. Simulated payments. Each run uses isolated synthetic demo data. The backend determines the outcome.</p>{!confirm ? <button type="button" className="cc-primary" disabled={!fixtureReady || busy} onClick={() => setConfirm(true)}>Prepare fixture demonstration <Icon name="arrow" size={16}/></button> : <div className="cc-confirm"><h4>Run this saved request?</h4><p>It may authorize a simulated refund, block the request, or require no action. This uses the existing server checks and creates an activity record.</p><div><button type="button" className="cc-primary" disabled={busy || !fixtureReady} onClick={() => void run()}>{busy ? 'Awaiting backend result…' : 'Confirm simulated run'}</button><button type="button" className="cc-secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></div></div>}{!fixtureReady && <p className="cc-run-limit">New runs require a connected fixture runtime and confirmed simulated payments. Live inference is not called from this page.</p>}</div>}
      {!order && props.load.status !== 'loading' && props.load.status !== 'error' && <p>The selected demo request is not available. Choose another case.</p>}
      <div className="cc-empty-choices">{HERO_ORDERS.map(id => <button type="button" className="cc-secondary" key={id} disabled={busy} onClick={() => select(hero(id))}>Order #{id}</button>)}</div>
    </section>}
    {busy && <p className="cc-notice" role="status">{slow ? 'This is taking longer than usual. The request may still finish. Do not submit a second run; wait for the backend result.' : 'Waiting for runtime checks and the backend response. No outcome is shown until the server returns a case.'}</p>}
    {error && <div className="cc-notice cc-error" role="alert"><strong>Could not confirm a new decision</strong><p>{error}</p><p>For a submitted request, an interrupted response does not prove that nothing happened. Check recorded activity before retrying.</p></div>}
  </div>;
}
