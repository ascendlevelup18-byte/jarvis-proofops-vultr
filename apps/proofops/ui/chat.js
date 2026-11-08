// Presentation adapter only. The existing control plane owns task interpretation and authority.
const $ = id => document.getElementById(id);
const node = (tag, cls, text) => { const n=document.createElement(tag); n.className=cls; if(text!==undefined)n.textContent=text; return n; };
const dialog=$('settings-dialog');
const conversation=$('conversation');
const advanced=document.querySelector('.layout');
$('activity-content').append(advanced);
const outcome=$('outcome'), approval=$('approval'), stop=$('cancel-btn');
stop.textContent='Stop';
const dock=node('div','task-controls');
dock.append(stop);document.querySelector('.composer-actions').prepend(dock);
// These nodes keep their original event handlers and exact backend-bound approval payload.
outcome.hidden=true; approval.hidden=true;
let response=null, statusLine=null, resultLine=null, active=false, approvalHash=null;
const money=n=>typeof n==='number'?`$${(n/100).toFixed(2)}`:'not recorded';
function closeSettings(){ if(dialog.open)dialog.close(); }
function openSettings(){ if(!dialog.open)dialog.showModal(); }
$('settings-open').addEventListener('click',openSettings);
$('settings-close').addEventListener('click',closeSettings);
dialog.addEventListener('close',()=>{$('settings-open').focus();});
for(const a of dialog.querySelectorAll('a'))a.addEventListener('click',closeSettings);
const theme=$('theme');
function applyTheme(value){ document.documentElement.dataset.theme=value==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):value; }
try {theme.value=localStorage.getItem('jarvis.theme')||'dark';}catch{}
applyTheme(theme.value);
theme.addEventListener('change',()=>{applyTheme(theme.value);try{localStorage.setItem('jarvis.theme',theme.value);}catch{}});
matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(theme.value==='system')applyTheme('system');});
$('clear-chat').addEventListener('click',()=>{
  if(active)return;
  // Detach reusable controller-owned nodes before clearing visual messages.
  $('activity-content').append(outcome,approval); outcome.hidden=approval.hidden=true;
  conversation.replaceChildren(); response=statusLine=resultLine=null;
  document.body.classList.remove('has-conversation');closeSettings();$('task-text').focus();
});
function ensureResponse(){if(!response)begin('Restored task');}
function begin(text){
  closeSettings();
  // Keep completed replies as read-only conversation turns, never old actionable approvals.
  if(response){if(!outcome.hidden){const copy=outcome.cloneNode(true);copy.removeAttribute('id');copy.removeAttribute('tabindex');copy.removeAttribute('role');response.insertBefore(copy,outcome);}outcome.remove();approval.remove();}
  document.body.classList.add('has-conversation');
  conversation.append(node('div','user-message',text));
  response=node('article','assistant-message');response.setAttribute('aria-label','JARVIS response');response.tabIndex=-1;
  response.append(node('div','assistant-name','JARVIS'));
  statusLine=node('p','chat-status','Sending your task…');
  resultLine=node('p','chat-answer');
  const turn=response;
  const details=node('button','details-link','View verification details');details.type='button';
  details.addEventListener('click',()=>{if(turn.dataset.runId){location.hash=`#evidence/${turn.dataset.runId}`;return;}openSettings();$('activity').open=true;$('activity').scrollIntoView({block:'start'});});
  outcome.hidden=approval.hidden=true;
  response.append(statusLine,resultLine,approval,outcome,details);conversation.append(response);
  active=true;approvalHash=null;$('clear-chat').disabled=true;response.focus({preventScroll:true});
}
function notice(text){ensureResponse();let n=response.querySelector('.chat-notice');if(!n){n=node('p','chat-notice');n.setAttribute('role','status');response.append(n);}n.textContent=text;}
function status(value){
  if(!response)return;
  active=['running','awaiting_approval'].includes(value);$('clear-chat').disabled=active;
  statusLine.textContent=({running:'Checking the demo store…',awaiting_approval:'Your approval is needed before the order.',completed:'Task finished. Reading the verification result…',failed:'The task could not finish.',timed_out:'The task reached its time limit.',cancelled:'Task stopped. No complete result is claimed.',unknown:'Connection lost. Task status is unknown.'})[value]||value;
  $('task-text').setAttribute('aria-describedby',active?'chat-busy':'task-h');
}
const busy=node('span','sr','A task is active. Stop it or wait before sending another.');busy.id='chat-busy';document.querySelector('.composer').append(busy);
export const chat={
  begin,closeSettings,notice,status,
  taskStatus(event){ensureResponse();statusLine.textContent=event.message;active=event.phase!=='finished';$('clear-chat').disabled=active;},
  taskResult(result,runId){
    ensureResponse();active=false;response.dataset.runId=runId;$('clear-chat').disabled=false;
    resultLine.textContent=result.message;
    statusLine.textContent=result.outcome==='VERIFIED_PASS'?'Completed and checked':result.outcome==='VERIFIED_FAIL'?'Verification failed':result.outcome==='EXECUTION_ERROR'?'Execution error':'Incomplete';
    $('chat-runtime').textContent=result.planner.label;
    response.querySelector('.chat-notice')?.remove();
  },
  accessLost(){
    ensureResponse();statusLine.textContent='Access to this task expired';
    resultLine.textContent='Your task status is unknown. The owner token is no longer accepted. No approval or successful result is being assumed.';
    outcome.hidden=approval.hidden=true;
    notice('Reload to check access again. Do not resend the task while its outcome is unknown.');
    if(!response.querySelector('.reconnect')){const b=node('button','ghost reconnect','Reconnect');b.type='button';b.addEventListener('click',()=>location.reload());response.append(b);}
  },
  runtime(text){$('chat-runtime').textContent=text;},
  accept(lines,text){if(!response)begin(text);statusLine.textContent='I’ll check this in the demo store.';resultLine.textContent=lines.slice(0,2).join(' · ');},
  event(e){if(!statusLine)return;if(e.type==='verifier.dom_read')statusLine.textContent='Verifying the result against your goal…';},
  revealApproval(hash){ensureResponse();if(approvalHash!==hash){approvalHash=hash;closeSettings();$('approval-h').focus({preventScroll:true});approval.scrollIntoView({block:'nearest',behavior:'auto'});}},
  result(s){
    ensureResponse();active=false;$('clear-chat').disabled=false;response.dataset.runId=s.runId;
    const observed=s.observed?.totals?.totalCents, expected=s.expected?.totalCents;
    if(s.outcomeClass==='verified_success')resultLine.textContent=`The task matched your goal.${typeof observed==='number'?` The cart total is ${money(observed)}.`:''}${typeof s.observed?.orders==='number'?` ${s.observed.orders===0?'No order was placed.':`${s.observed.orders} synthetic order recorded.`}`:''}`;
    else if(s.outcomeClass==='verified_fail' && typeof observed==='number' && typeof expected==='number' && observed!==expected)resultLine.textContent=`I checked the total. The store returned ${money(observed)}, but your goal expected ${money(expected)}, so verification failed.`;
    else resultLine.textContent=({order_not_approved:'The order was not approved. No order was placed.',cancelled:'You stopped the task before it finished. This is not a verified success.',timed_out:'The task timed out before it could finish. The result is incomplete.',evidence_integrity_failure:'The evidence could not be trusted. Do not rely on this result.',incomplete_evidence:'The evidence is incomplete. I cannot verify this result.'})[s.outcomeClass]||'The task did not produce a verified match. Review the recorded result below.';
    statusLine.textContent=s.outcomeClass==='verified_success'?'Completed and checked':'Result needs attention';
    response.querySelector('.chat-notice')?.remove();
  },
  unavailable(){ensureResponse();resultLine.textContent='The result summary is unavailable. I cannot confirm the outcome or evidence integrity.';},
  error(text,uncertain=false){active=false;$('clear-chat').disabled=false;statusLine.textContent=uncertain?'Start not confirmed':'Task not started';resultLine.textContent=text;response.querySelector('.details-link').hidden=true;},
  connectionLost(){notice('Connection interrupted. Reconnecting to the same task; no new task has been started.');statusLine.textContent='Connection interrupted';},
  completed(){if(response && !dialog.open && !(document.activeElement===$('task-text') && $('task-text').value.trim())){outcome.scrollIntoView({block:'center',behavior:'auto'});outcome.focus({preventScroll:true});}}
};
