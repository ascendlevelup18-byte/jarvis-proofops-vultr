import { useEffect, useMemo, useState } from 'react';
import type { DemoStoreSnapshot } from '../../lib/demo-store.ts';
import { comparison, dayKey, demoOrderDays, metricValue, overviewWindow, sampleStoreDays, shiftDay, totals, type OverviewMetric, type StoreDay } from '../../lib/store-overview.ts';
import { formatMinor } from '../../lib/money.ts';
import type { StoreLoad } from '../../pages/OrdersPage.tsx';
import { Icon } from '../ui/Icon.tsx';

const METRICS: {id: OverviewMetric; label: string; icon: 'activity' | 'chart' | 'orders' | 'spark'}[] = [
 {id:'sessions',label:'Sessions',icon:'activity'}, {id:'sales',label:'Total sales',icon:'chart'},
 {id:'orders',label:'Total orders',icon:'orders'}, {id:'conversion',label:'Conversion rate',icon:'spark'},
];
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {month:'short',day:'numeric', timeZone:'UTC'});
const number = (value: number | null, metric: OverviewMetric, currency: string) => value === null ? '—' : metric === 'sales' ? formatMinor(value,currency) : metric === 'conversion' ? `${value.toFixed(2)}%` : value.toLocaleString('en-US');

export function StoreOverview({ snapshot, load, onReload }: {snapshot: DemoStoreSnapshot | null; load: StoreLoad; onReload: () => void}) {
 const [sample, setSample] = useState(false);
 const [days, setDays] = useState(14);
 const [offset, setOffset] = useState(0);
 const [compare, setCompare] = useState(true);
 const [metric, setMetric] = useState<OverviewMetric>('sales');
 const [today] = useState(() => dayKey(new Date()));
 const currency = sample ? 'USD' : snapshot?.orders[0]?.currency ?? 'USD';
 const rows = useMemo(() => sample ? sampleStoreDays(today) : demoOrderDays(snapshot, currency), [sample,today,snapshot,currency]);
 const anchor = sample ? today : rows.at(-1)?.date ?? today;
 const end = shiftDay(anchor,-offset*days);
 const window = overviewWindow(rows,end,days,sample);
 const current = totals(window.current), previous = totals(window.previous);
 const noTraffic = !sample && (metric === 'sessions' || metric === 'conversion');

 return <section className="store-overview" aria-label="Store overview">
  <div className="overview-toolbar">
   <div className="data-switch" role="group" aria-label="Analytics data source">
    <button type="button" aria-pressed={!sample} onClick={() => {setSample(false);setOffset(0);}}>Demo orders</button>
    <button type="button" aria-pressed={sample} onClick={() => {setSample(true);setOffset(0);}}>Sample store</button>
   </div>
   <span className={`data-note ${sample ? 'sample-note' : ''}`}>{sample ? 'Sample data · illustrative, not your store' : 'Demo order values · before refunds · no visit tracking'}</span>
  </div>
  <div className="store-metrics">
   {METRICS.map((m) => <button type="button" key={m.id} className={`store-metric metric-${m.id}`} aria-pressed={metric===m.id} onClick={() => setMetric(m.id)}>
    <span className="metric-top"><span>{m.label}</span><Icon name={m.icon}/></span>
    <strong>{load.status==='loading' && !sample && !snapshot ? '…' : number(current[m.id],m.id,currency)}</strong>
    <span className="metric-comparison">{comparison(current[m.id],previous[m.id])}</span>
    <span className="metric-source">{sample ? 'Sample' : m.id==='sessions'||m.id==='conversion' ? 'Unavailable' : m.id==='sales' ? `Demo order value · ${currency}` : `Demo orders · ${currency}`}</span>
   </button>)}
  </div>
  <div className="sales-chart-card">
   <div className="chart-heading">
    <div><p className="eyebrow">STORE PERFORMANCE{sample ? ' · SAMPLE' : ' · DEMO'}</p><h3>{METRICS.find(m=>m.id===metric)?.label} over time</h3></div>
    <div className="chart-controls">
     <label><span className="sr-only">Date range</span><select aria-label="Date range" value={days} onChange={e=>{setDays(Number(e.target.value));setOffset(0);}}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={28}>Last 28 days</option></select></label>
     <label className="compare-toggle"><input type="checkbox" checked={compare} onChange={e=>setCompare(e.target.checked)}/> Compare</label>
    </div>
   </div>
   <div className="chart-period"><span>{dateLabel(window.current[0].date)} – {dateLabel(end)}, {end.slice(0,4)} · {sample ? 'sample dates' : 'demo dates (UTC)'}</span><div><button type="button" aria-label="Previous date range" onClick={()=>setOffset(v=>v+1)} disabled={offset>=1}>←</button><button type="button" aria-label="Next date range" disabled={offset===0} onClick={()=>setOffset(v=>v-1)}>→</button></div></div>
   {load.status==='loading' && !sample && !snapshot ? <div className="chart-empty" role="status">Loading demo orders…</div> : load.status==='error' && !sample ? <div className="chart-empty" role="alert"><strong>Could not load the demo store</strong><p>{load.error}</p><button type="button" onClick={onReload}>Try again</button></div> : noTraffic ? <div className="chart-empty"><Icon name="chart" size={32}/><strong>Visit tracking isn’t connected</strong><p>Sessions and conversion rate need store visit data.</p><button type="button" onClick={()=>{setSample(true);setOffset(0);}}>Explore labeled sample data <Icon name="arrow" size={15}/></button></div> : <LineChart key={`${sample}-${days}-${offset}-${metric}`} current={window.current} previous={window.previous} compare={compare} metric={metric} currency={currency}/>}
   <div className="chart-footer"><span><i/> Selected period</span>{compare&&<span><i className="comparison-key"/> Previous {days} days</span>}<span className="ml-auto">{sample ? 'Illustrative sample · no live store activity' : 'Order totals are not net revenue. Refunds are tracked in Analytics.'}</span></div>
  </div>
 </section>;
}

function LineChart({current,previous,compare,metric,currency}:{current:StoreDay[];previous:StoreDay[];compare:boolean;metric:OverviewMetric;currency:string}) {
 const [hover,setHover]=useState<number|null>(null);
 const [compact,setCompact]=useState(false);
 useEffect(()=>{const media=window.matchMedia('(max-width: 620px)');const update=()=>setCompact(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
 const width=compact?360:960, left=compact?58:64, right=compact?336:920, bottom=compact?180:220, top=compact?20:36;
 const plotWidth=right-left;
 const values=current.map(d=>metricValue(d,metric)), old=previous.map(d=>metricValue(d,metric));
 const max=Math.max(...values,...(compare?old:[]),1)*1.2;
 const x=(i:number)=>left+i*plotWidth/(current.length-1), y=(v:number)=>bottom-v/max*(bottom-top);
 const curve=(items:number[])=>items.map((v,i)=>i===0?`M${x(i)},${y(v)}`:`C${(x(i-1)+x(i))/2},${y(items[i-1])} ${(x(i-1)+x(i))/2},${y(v)} ${x(i)},${y(v)}`).join(' ');
 const label=(v:number)=>metric==='sales'?new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:0}).format(v/100):metric==='conversion'?`${v.toFixed(1)}%`:Math.round(v).toLocaleString('en-US');
 const empty=values.every(v=>v===0);
 return <div className="chart-plot">
  <svg viewBox={`0 0 ${width} ${compact?220:270}`} role="img" aria-label={`${metric} chart: ${dateLabel(current[0].date)} to ${dateLabel(current.at(-1)!.date)}. Values in the data table below.`}>
   <defs><linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#356fe0" stopOpacity=".20"/><stop offset="100%" stopColor="#356fe0" stopOpacity=".01"/></linearGradient></defs>
   {[0,.25,.5,.75,1].map(t=><g key={t}><line x1={left} x2={right} y1={y(t*max)} y2={y(t*max)} stroke="#e2e9f2" strokeDasharray={t?'3 5':undefined}/><text x={left-10} y={y(t*max)+4} textAnchor="end" fill="#52647b" fontSize="11">{label(t*max)}</text></g>)}
   <path d={`${curve(values)} L${right},${bottom} L${left},${bottom} Z`} fill="url(#sales-fill)"/>
   {compare&&<path d={curve(old)} fill="none" stroke="#879dbf" strokeWidth="2" strokeDasharray="4 7"/>}
   <path d={curve(values)} fill="none" stroke="#3268cf" strokeWidth="3" strokeLinecap="round"/>
   {current.map((d,i)=>i===0||i===current.length-1||(compact?i===Math.floor(current.length/2):i%Math.ceil(current.length/5)===0)?<text key={d.date} x={x(i)} y={compact?208:252} textAnchor="middle" fill="#52647b" fontSize="11">{dateLabel(d.date)}</text>:null)}
   {hover!==null&&<g><line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} stroke="#7095d3" strokeDasharray="3 4"/><circle cx={x(hover)} cy={y(values[hover])} r="5" fill="#3268cf" stroke="white" strokeWidth="3"/></g>}
   {current.map((d,i)=><rect key={d.date} x={Math.max(left,x(i)-plotWidth/2/(current.length-1))} y="20" width={plotWidth/(current.length-1)} height={bottom-16} fill="transparent" tabIndex={0} role="button" aria-label={`${dateLabel(d.date)}: ${number(values[i],metric,currency)}${compare?`, previous ${number(old[i],metric,currency)}`:''}`} onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)} onFocus={()=>setHover(i)} onBlur={()=>setHover(null)} onClick={()=>setHover(i)}/>) }
  </svg>
  {hover!==null&&<div role="status" className="chart-tooltip" style={{left:`${Math.min(70,Math.max(3,x(hover)/width*100-10))}%`}}><strong>{dateLabel(current[hover].date)}</strong><span>This period <b>{number(values[hover],metric,currency)}</b></span>{compare&&<span>Previous <b>{number(old[hover],metric,currency)}</b></span>}</div>}
  {empty&&<p className="chart-empty-label">No orders in this period. Choose another range or explore sample data.</p>}
  <details className="chart-data"><summary>View chart data</summary><div className="overflow-x-auto"><table><caption className="sr-only">Values shown in the chart</caption><thead><tr><th>Date</th><th>This period</th>{compare&&<th>Previous period (aligned)</th>}</tr></thead><tbody>{current.map((d,i)=><tr key={d.date}><th scope="row">{dateLabel(d.date)}</th><td>{number(values[i],metric,currency)}</td>{compare&&<td>{dateLabel(previous[i].date)} · {number(old[i],metric,currency)}</td>}</tr>)}</tbody></table></div></details>
 </div>;
}
