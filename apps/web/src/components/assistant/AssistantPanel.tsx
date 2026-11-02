import { useRef, useState, type FormEvent } from 'react';
import type { Case } from '../../lib/case-types.ts';
import { assistantIntent, type AssistantIntent } from '../../lib/assistant-intent.ts';
import { customerReply, describeOrderBalance, type DemoStoreOrder, type DemoStoreSnapshot } from '../../lib/demo-store.ts';
import { explainDecision } from '../../lib/proof.ts';
import { formatMinor } from '../../lib/money.ts';
import type { NavId } from '../../lib/system-truth.ts';
import type { SessionCaseEntry } from '../../lib/session-store.ts';
import { Icon } from '../ui/Icon.tsx';
import { btn } from '../ui/styles.ts';

const SUGGESTIONS=["Check today's orders",'Help with a customer complaint','Review a refund request','Show me what needs attention'];
type Turn={text:string;intent:AssistantIntent};
export interface AssistantProps {
 snapshot:DemoStoreSnapshot|null; history:SessionCaseEntry[];
 onNavigate:(nav:NavId)=>void; onRunOrder:(o:DemoStoreOrder)=>Promise<Case>;
 onOpenCase:(id:string)=>void;
}

export function AssistantPanel({snapshot,history,onNavigate,onRunOrder,onOpenCase}:AssistantProps) {
 const [open,setOpen]=useState(true),[draft,setDraft]=useState('');
 const [turn,setTurn]=useState<Turn|null>(null),[order,setOrder]=useState<DemoStoreOrder|null>(null);
 const [result,setResult]=useState<Case|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const inFlight=useRef(false);
 const needsReview=history.filter(h=>h.state==='ESCALATED'||h.state==='FAILED');
 const ask=(text:string)=>{
  if(!text.trim()||inFlight.current)return;
  setTurn({text:text.trim(),intent:assistantIntent(text)});setDraft('');setResult(null);setError(null);
  const id=text.match(/\b\d{5}\b/)?.[0];
  setOrder(id?snapshot?.orders.find(o=>o.orderId===id)??null:null);
 };
 const submit=(e:FormEvent)=>{e.preventDefault();ask(draft);};
 const run=async()=>{
  if(!order||inFlight.current)return;
  inFlight.current=true;setBusy(true);setError(null);
  try{setResult(await onRunOrder(order));}catch(e){setError(e instanceof Error?e.message:'Could not complete the request. Nothing is confirmed.');}
  finally{inFlight.current=false;setBusy(false);}
 };
 const reply=result?customerReply(result):null;
 return <section className="assistant-panel" aria-labelledby="assistant-title">
  <header className="assistant-header"><div className="assistant-emblem"><Icon name="spark" size={25}/></div><div><p className="eyebrow">A HELPING HAND FOR YOUR STORE</p><h2 id="assistant-title">Your AI Store Assistant</h2><p>Ask JARVIS to handle something for your store.</p></div><button className="assistant-collapse" type="button" aria-expanded={open} aria-controls="assistant-body" aria-label={open?'Collapse assistant':'Open assistant'} onClick={()=>setOpen(!open)}><Icon name={open?'close':'spark'}/></button></header>
  {open&&<div id="assistant-body" className="assistant-body">
   {!turn&&<div className="assistant-welcome"><span className="assistant-orbit" aria-hidden="true">✦</span><div><strong>Less busywork. More peace of mind.</strong><p>I can find demo orders, help review duplicate charges, and show what needs your attention.</p></div></div>}
   {turn&&<div className="assistant-conversation" aria-live="polite">
    <p className="user-prompt"><span className="sr-only">You: </span>{turn.text}</p>
    <div className="assistant-response"><span className="assistant-mini"><Icon name="spark" size={16}/></span><div className="min-w-0 flex-1">
     {turn.intent==='orders'&&<><h3>Here are your demo orders</h3><p>{snapshot?`${snapshot.orders.length} seeded orders are available. They are demo records, not today’s live sales.`:'Demo orders are still loading. Please try again shortly.'}</p>{snapshot&&<div className="assistant-order-list">{snapshot.orders.map(o=><button type="button" key={o.orderId} onClick={()=>onNavigate('orders')}><span><b>#{o.orderId}</b> · {o.customerName}</span><span>{formatMinor(o.totalMinor,o.currency)} <Icon name="chevron" size={14}/></span></button>)}</div>}</>}
     {turn.intent==='attention'&&<><h3>{needsReview.length?`${needsReview.length} case${needsReview.length===1?'':'s'} need a person`:'You’re all caught up'}</h3><p>{needsReview.length?'These requests could not be safely completed automatically. The review queue shows the evidence and reasons.':'No recorded cases need review. You can start with a demo refund request.'}</p><button type="button" className={`${btn.secondary} mt-3`} onClick={()=>onNavigate('approvals')}>View review queue <Icon name="arrow" size={15}/></button></>}
     {turn.intent==='unsupported'&&<><h3>I can help with a smaller set of tasks</h3><p>This guided demo can look up orders, review preset refund requests, and show cases needing attention. Other store changes and open-ended AI chat aren’t available here. Nothing was changed.</p><button type="button" className={`${btn.secondary} mt-3`} onClick={()=>ask('Review a refund request')}>Review a refund request</button></>}
     {turn.intent==='review'&&<>
      <h3>{result?reply?.title:order?'Here’s the request I can review':'Which order needs help?'}</h3>
      {!order&&<><p>Choose a demo order. I’ll show its saved customer request before you run the review.</p>{turn.text.match(/\b\d{5}\b/)&&<p>That order number was not found. Nothing was changed.</p>}<div className="assistant-order-list">{snapshot?.orders.map(o=><button key={o.orderId} type="button" onClick={()=>{setOrder(o);setResult(null);}}><span><b>#{o.orderId}</b> · {o.customerName}</span><span>{formatMinor(o.totalMinor,o.currency)}<Icon name="chevron" size={14}/></span></button>)??<p>Demo orders are still loading.</p>}</div></>}
      {order&&!result&&<><p>I’ll send the saved request through JARVIS’s refund checks. Only an authorized simulated refund can run; the result must be verified.</p><dl className="assistant-plan"><div><dt>Customer / order</dt><dd>{order.customerName} · #{order.orderId}</dd></div><div><dt>Problem to review</dt><dd>{order.supportRequest.message}</dd></div><div><dt>Payment records</dt><dd>{describeOrderBalance(order)}</dd></div><div><dt>Proposed action</dt><dd>Review the duplicate charge; refund only if checks allow it.</dd></div><div><dt>Permission</dt><dd>Server checks every request. Unsafe or unclear cases need a person outside this demo.</dd></div><div><dt>Status</dt><dd>{busy?'Checking the request…':'Ready for your confirmation · nothing changed yet'}</dd></div></dl><div className="flex flex-wrap gap-2 mt-3"><button type="button" disabled={busy} className={btn.primary} onClick={run}>{busy?'Reviewing…':'Review & run demo request'}<Icon name="arrow" size={15}/></button><button type="button" disabled={busy} className={btn.secondary} onClick={()=>{setOrder(null);setTurn(null);}}>Cancel</button></div></>}
      {result&&<><p>{reply?.body}</p><dl className="assistant-plan"><div><dt>Order</dt><dd>#{result.request.orderId}</dd></div><div><dt>AI suggestion</dt><dd>{result.proposal?.action==='REFUND_DUPLICATE'?'Refund the duplicate charge':result.proposal?.action==='NO_ACTION'?'No further action':'Review with a person'}</dd></div><div><dt>Reason</dt><dd>{explainDecision(result).points[0]}</dd></div><div><dt>Permission</dt><dd>{result.authorization?.outcome==='APPROVE'?'Allowed by server checks':result.authorization?.outcome==='NO_ACTION'?'No refund needed':'Automatic action not authorized'}</dd></div><div><dt>Verification</dt><dd>{result.verification?.verified&&result.verification.observedRefund?'Simulated refund confirmed':'No refund confirmed'}</dd></div><div><dt>Next step</dt><dd>{result.state==='ESCALATED'||result.state==='FAILED'?'Review outside JARVIS. Approve / reject is not available in this demo.':'View the activity record for this case.'}</dd></div></dl><button type="button" className={`${btn.secondary} mt-3`} onClick={()=>onOpenCase(result.id)}>View decision & activity <Icon name="arrow" size={15}/></button></>}
     </>}
     {error&&<p role="alert" className="assistant-error">{error}</p>}
    </div></div>
   </div>}
   <div className="assistant-suggestions" aria-label="Example requests">{SUGGESTIONS.map(s=><button type="button" key={s} disabled={busy} onClick={()=>ask(s)}>{s}<Icon name="arrow" size={13}/></button>)}</div>
   <form className="assistant-composer" onSubmit={submit}><label htmlFor="assistant-input" className="sr-only">Ask JARVIS</label><Icon name="spark"/><input id="assistant-input" value={draft} maxLength={500} disabled={busy} onChange={e=>setDraft(e.target.value)} placeholder="Ask me about an order, customer, or refund..."/><button type="submit" disabled={!draft.trim()||busy} aria-label="Send request"><Icon name="arrow" size={18}/></button></form>
   <p className="assistant-disclosure"><Icon name="shield" size={13}/> Guided demo · typed text stays in your browser. Refund reviews use saved requests and the AI mode shown above. Payments are simulated.</p>
  </div>}
 </section>;
}
