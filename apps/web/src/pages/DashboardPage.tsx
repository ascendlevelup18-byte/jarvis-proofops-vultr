import { StoreOverview } from '../components/dashboard/StoreOverview.tsx';
import { AssistantPanel, type AssistantProps } from '../components/assistant/AssistantPanel.tsx';
import { Icon } from '../components/ui/Icon.tsx';
import { StateBadge } from '../components/ui/StateBadge.tsx';
import type { StoreLoad } from './OrdersPage.tsx';

export function DashboardPage({load,onReload,...assistant}:AssistantProps&{load:StoreLoad;onReload:()=>void}) {
 const review=assistant.history.filter(h=>h.state==='ESCALATED'||h.state==='FAILED');
 return <div className="home-page motion-fade-in">
  <header className="home-heading"><div><p className="eyebrow">YOUR STORE, AT A GLANCE</p><h2>Welcome back<span>.</span></h2><p>Let’s make it a good day for your store.</p></div><button type="button" className="attention-link" onClick={()=>assistant.onNavigate('approvals')}><span className="attention-dot"/>{review.length?`${review.length} need your attention`:'Nothing needs review'}<Icon name="chevron" size={16}/></button></header>
  <StoreOverview snapshot={assistant.snapshot} load={load} onReload={onReload}/>
  <AssistantPanel {...assistant}/>
  <section className="home-bottom" aria-label="Your next steps"><div className="recent-card"><header><h3>Recent activity</h3><button type="button" onClick={()=>assistant.onNavigate('activity')}>View all <Icon name="arrow" size={14}/></button></header>{assistant.history.length?<ul>{assistant.history.slice(0,3).map(h=><li key={h.id}><button type="button" onClick={()=>assistant.onOpenCase(h.id)}><span><strong>Order #{h.orderId}</strong><small>{h.scenarioTitle??'Refund request'}</small></span><StateBadge state={h.state}/></button></li>)}</ul>:<div className="recent-empty"><Icon name="activity" size={26}/><p>No activity yet</p><span>Your reviewed requests will appear here.</span></div>}</div><div className="next-step-card"><span className="next-step-icon"><Icon name="shield" size={25}/></span><p className="eyebrow">BUILT TO KEEP YOU IN CONTROL</p><h3>One request.<br/>Every check.</h3><p>Start with a duplicate charge. JARVIS checks the records, follows the rules, and verifies the result.</p><button type="button" onClick={()=>assistant.onNavigate('operations')}>Explore demo scenarios <Icon name="arrow" size={16}/></button></div></section>
 </div>;
}
