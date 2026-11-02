import { useState, type ReactNode } from 'react';
import { navLabel, type NavId } from '../../lib/system-truth.ts';
import type { DemoStoreSnapshot } from '../../lib/demo-store.ts';
import type { Route } from '../../lib/routes.ts';
import type { SessionCaseEntry } from '../../lib/session-store.ts';
import { RuntimeChips } from '../ui/RuntimeChips.tsx';
import { GlobalSearch } from './GlobalSearch.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';

const PRIMARY:{id:NavId;icon:IconName}[]=[{id:'judge',icon:'shield'},{id:'dashboard',icon:'home'},{id:'command-center',icon:'shield'},{id:'orders',icon:'orders'},{id:'customers',icon:'customers'},{id:'inbox',icon:'inbox'},{id:'assistant',icon:'spark'},{id:'team',icon:'customers'},{id:'benchmarks',icon:'chart'},{id:'approvals',icon:'shield'},{id:'activity',icon:'activity'},{id:'settings',icon:'settings'}];
export function OpsShell({activeNav,onNavigate,actions,badges,store,history,pendingReview,onSearchSelect,children}:{activeNav:NavId;onNavigate:(id:NavId)=>void;actions?:ReactNode;badges?:Partial<Record<NavId,number>>;store:DemoStoreSnapshot|null;history:SessionCaseEntry[];pendingReview:number;onSearchSelect:(r:Route)=>void;children:ReactNode}) {
 const [menu,setMenu]=useState(false);
 const go=(id:NavId)=>{setMenu(false);onNavigate(id);};
 const item=(id:NavId,icon:IconName)=><li key={id}><button type="button" aria-current={activeNav===id?'page':undefined} onClick={()=>go(id)} className={activeNav===id?'nav-active':''}><Icon name={icon}/><span>{navLabel(id)}</span>{!!badges?.[id]&&<b className="nav-badge">{badges[id]}</b>}{id==='assistant'&&<span className="nav-ai">AI</span>}</button></li>;
 return <div className="merchant-layout">
  <a className="skip-link" href="#main">Skip to main content</a>
  <aside onKeyDown={e=>{if(e.key==='Escape')setMenu(false);}} className={`merchant-sidebar ${menu?'mobile-open':''}`}>
   <div className="brand-row"><button type="button" className="brand" onClick={()=>go('dashboard')} aria-label="JARVIS Home"><span className="brand-mark">J<span/></span><span>JARVIS<small>COMMERCE, IN CONTROL</small></span></button><button type="button" className="mobile-close" onClick={()=>setMenu(false)} aria-label="Close navigation"><Icon name="close"/></button></div>
   <div className="workspace-tag"><span className="store-avatar">N</span><span>{store?.store.name??'Demo store'}<small>Demo workspace</small></span><Icon name="chevron" size={13}/></div>
   <nav aria-label="Primary"><p className="nav-label">WORKSPACE</p><ul>{PRIMARY.map(i=>item(i.id,i.icon))}</ul><details className="workspace-tools" open={['operations','cases','automations','system'].includes(activeNav)||undefined}><summary>Demo & advanced tools</summary><ul>{item('operations','shield')}{item('cases','orders')}{item('automations','spark')}{item('system','settings')}</ul></details></nav>
   <div className="sidebar-note"><span className="sidebar-note-icon"><Icon name="shield" size={18}/></span><strong>A safe space to explore</strong><p>Demo data. Simulated payments.<br/>No real money moves.</p></div>
   <button type="button" className="sidebar-profile" onClick={()=>go('settings')}><span className="profile-avatar">DM</span><span>Demo merchant<small>Workspace settings</small></span><Icon name="settings" size={17}/></button>
  </aside>
  <div className="merchant-content">
   <header className="merchant-topbar"><div className="topbar-main"><button className="mobile-menu" type="button" aria-expanded={menu} aria-label="Open navigation" onClick={()=>setMenu(!menu)}><Icon name="menu"/></button><span className="topbar-page">{navLabel(activeNav)}</span><div className="topbar-search"><GlobalSearch store={store} history={history} onSelect={onSearchSelect}/></div><button type="button" className="top-assistant" onClick={()=>go('assistant')}><Icon name="spark" size={17}/><span>AI Assistant</span></button><details className="notifications"><summary aria-label={`Notifications: ${pendingReview} need review`}><Icon name="bell"/>{pendingReview>0&&<span className="notification-dot"/>}</summary><div className="notifications-popover"><strong>{pendingReview?`${pendingReview} cases need review`:'You’re all caught up'}</strong><p>{pendingReview?'Some requests need a person before anything else can happen.':'New review requests will appear here.'}</p><button type="button" onClick={()=>go('approvals')}>View review queue <Icon name="arrow" size={14}/></button></div></details><details className="merchant-profile"><summary aria-label="Merchant profile"><span className="profile-avatar">DM</span><span>Demo merchant<small>{store?.store.name??'Demo store'}</small></span></summary><div className="profile-popover"><strong>Demo workspace</strong><p>Synthetic store data · simulated payments.</p>{actions}</div></details></div><div className="runtime-bar"><span className="demo-label">DEMO WORKSPACE</span><RuntimeChips/></div></header>
   <main id="main" className="merchant-main">{children}</main>
  </div>
 </div>;
}
