import { requestJson } from './api.js';
import { translate } from './i18n.js';
import { formatDate } from './date.js';
import { createDialogFocusTrap } from './dialog-focus.js';

// Product flow only. The backend owns dispatch, validation, versions and application.
export function createCyclePlanning({ i18n, user }) {
  const modal = document.getElementById('cyclePlanningModal');
  const content = document.getElementById('cyclePlanningContent');
  const status = document.getElementById('cyclePlanningStatus');
  const error = document.getElementById('cyclePlanningError');
  const generate = document.getElementById('cyclePlanningGenerate');
  const apply = document.getElementById('cyclePlanningApply');
  const cancel = document.getElementById('cyclePlanningCancel');
  const debug = document.getElementById('cyclePlanningDebug');
  const later = document.getElementById('cyclePlanningLater');
  const retry = document.getElementById('cyclePlanningRetry');
  const pendingKeys = new Map();
  let cycleId=null, trigger=null, state=null, generation=0, readSequence=0, timer=null, busy=false, errorCode=null, saved=null, readFailed=false;
  const t = (key) => translate(i18n.messages,`cyclePlanning.${key}`);
  const trap=createDialogFocusTrap(modal,close);
  const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;};
  function showError(e, read=false, focus=true) {
    if (read) readFailed=true;
    const running=state?.proposals?.[0]?.execution && ['queued','running'].includes(state.proposals[0].execution.state);
    errorCode=read ? (running ? 'progressLoadError' : saved ? 'savedLoadError' : 'loadError') : e?.codes?.[0] || 'generic';
    const localized=t(`errors.${errorCode}`);
    error.textContent=localized.startsWith('cyclePlanning.')?t('errors.generic'):localized;
    error.hidden=false;render();if(focus)error.focus();
  }
  function renderPlan(plan,heading,version=null) {
    const section=el('section',null,'cycle-plan-section');
    const header=el('header',null,'cycle-card-header');header.append(el('h3',heading));
    if(version!==null)header.append(el('span',`${t('version')} ${version}`,'cycle-status status-active'));
    section.append(header);
    const pair=(label,value)=>{const p=el('p');p.append(el('strong',`${label}: `),document.createTextNode(value));section.append(p);};
    pair(t('period'),`${formatDate(plan.start,i18n.language)} → ${formatDate(plan.end,i18n.language)}`);
    for(const field of ['assessment','continuity','feasibility']) pair(t(field),plan[field]);
    pair(t('confidence'),t(`confidenceValues.${plan.confidence}`));
    section.append(el('h4',t('architecture')));
    for(const phase of plan.phases) {
      const article=el('article',null,'cycle-plan-phase');article.append(el('h4',`${phase.name} · ${formatDate(phase.start,i18n.language)} → ${formatDate(phase.end,i18n.language)}`));
      for(const field of ['objective','volume','longRuns','quality','intensity','easyRuns','strength','risks','advanceCriteria','rationale']) {
        const p=el('p');p.append(el('strong',`${t(field)}: `),document.createTextNode(phase[field]));article.append(p);
      }
      section.append(article);
    }
    for(const field of ['indicators','uncertainties','assumptions','questions']) if(plan[field].length) {
      section.append(el('h4',t(field)));const list=el('ul');for(const value of plan[field])list.append(el('li',value));section.append(list);
    }
    section.append(el('h4',t('adaptations')));
    for(const [field,value] of Object.entries(plan.adaptations)) pair(t(field),value);
    content.append(section);
  }
  function render() {
    const current = state?.applied && !state.applied.outdated && !state.applied.compatibilityError;
    const hint = saved && state?.available===false ? 'savedUnavailableHint' : saved === 'add' ? 'createdHint' : saved === 'edit' ?
      (state?.applied?.outdated ? 'editedOutdatedHint' : current ? 'editedCurrentHint' : 'editedHint') : 'hint';
    document.getElementById('cyclePlanningHint').textContent=t(hint);
    later.textContent=t(state?.applied?.outdated ? 'keep' : current || state?.available===false || state?.canGenerate===false ? 'done' : 'notNow');
    later.className='btn-secondary';
    retry.hidden=!readFailed;retry.disabled=busy;retry.className='btn-primary';retry.textContent=t('retryLoad');
    generate.hidden=!state || readFailed;
    if(!state){status.textContent=t(readFailed && !busy?'loadFailed':'loading');generate.textContent=t('generate');return;}
    const latest=state.proposals[0];const execution=latest?.execution;
    const running=execution && ['queued','running'].includes(execution.state);
    const candidate=execution?.state==='completed' && !latest.applied;
    const conflict=candidate && latest.baseVersion!==(state.applied?.version || 0);
    const ready=candidate && !latest.compatibilityError && !execution.outdated && !conflict && state.canGenerate;
    generate.textContent=t(state.proposals.length?'regenerate':'generate');
    generate.hidden=readFailed || !state.available || !state.canGenerate || Boolean(running) || Boolean(saved && current && !ready);
    generate.className=ready?'btn-secondary':'btn-primary';
    generate.disabled=readFailed || busy || !state.available || !state.canGenerate || running;
    apply.hidden=!ready || readFailed;apply.disabled=readFailed || busy;
    later.className=!readFailed && (!state.available || !state.canGenerate || (saved && current && !ready)) && !ready ? 'btn-primary' : 'btn-secondary';
    if(running)later.textContent=t('close');
    cancel.hidden=!running;cancel.disabled=busy;
    debug.hidden=user.role!=='admin' || !execution;
    document.getElementById('cyclePlanningAdmin').hidden=debug.hidden;
    const statusMessage=readFailed?t(busy?'loading':errorCode==='progressLoadError'?'progressLoadFailed':'loadFailed'):busy?t('loading'):!state.available?t('unavailable'):!state.canGenerate?t('inactiveCycle'):latest?.applied?t(state.applied?.outdated || state.applied?.compatibilityError?'appliedNeedsReview':'applied'):latest?.compatibilityError?t('proposalIncompatible'):candidate && (execution.outdated || conflict)?t('proposalOutdated'):execution?.error==='providerRateLimited' && running?t('retryWaiting'):execution?.state==='queued'?(execution?.error==='providerRateLimited'?t('retryWaiting'):t('states.queued')):execution?.state==='running'?t('states.running'):execution?t(`states.${execution.state}`):t(saved?'readyToPlan':'manualIndependent');
    // Avoid rewriting the polite live region on every polling response.
    if(status.textContent!==statusMessage)status.textContent=statusMessage;
    content.replaceChildren();
    if(candidate) {
      if(latest.baseVersion!==(state.applied?.version || 0))content.append(el('p',t('proposalConflict'),'field-hint'));
      if(execution.outdated)content.append(el('p',t('outdated'),'field-hint'));
      renderPlan(execution.response,t('proposal'));
    }
    if(state.applied) {
      if(state.applied.compatibilityError)content.append(el('p',t('appliedRpeIncompatible'),'field-hint'));
      if(state.applied.outdated)content.append(el('p',t('appliedOutdated'),'field-hint'));
      renderPlan(state.applied.plan,t('applied'),state.applied.version);
    }
    if(!candidate && !state.applied)content.append(el('p',t('empty'),'field-hint'));
    if(!errorCode && !readFailed) {
      error.hidden=true;
      const failure=(!latest?.applied && latest?.compatibilityError) || execution?.error;
      if(!busy && failure && !running) {
        const message=t(`errors.${failure}`);
        error.textContent=message.startsWith('cyclePlanning.')?t('errors.generic'):message;
        error.hidden=false;
      }
    }
  }
  async function refresh(token=generation) {
    if(token!==generation || modal.hidden)return;
    const request=++readSequence;
    let readTimer;
    let result;
    try {
      result=await Promise.race([
        requestJson(`/api/cycles/${encodeURIComponent(cycleId)}/planning`,undefined,'GET'),
        new Promise((_,reject)=>{readTimer=setTimeout(()=>reject(Object.assign(new Error(),{codes:['planningReadTimeout']})),10000);}),
      ]);
    } finally { clearTimeout(readTimer); }
    if(token!==generation || request!==readSequence || modal.hidden)return;
    state=result;readFailed=false;error.hidden=true;errorCode=null;render();clearTimeout(timer);
    if(state.proposals[0]?.execution && ['queued','running'].includes(state.proposals[0].execution.state))
      timer=setTimeout(()=>refresh(token).catch((e)=>{if(token===generation && !modal.hidden)showError(e,true,false);}),1500);
  }
  async function action(fn, allowEmpty=false) {
    if(busy || (!state && !allowEmpty))return;
    const token=generation;busy=true;error.hidden=true;errorCode=null;render();
    try {
      await fn();
      if(token===generation && !modal.hidden)try { await refresh(token); } catch(e) { if(token===generation && !modal.hidden)showError(e,true); }
    }
    catch(e){if(token===generation && !modal.hidden)showError(e);}
    finally{if(token===generation){busy=false;render();if(!modal.hidden && document.activeElement===document.body)document.getElementById('cyclePlanningClose').focus();}}
  }
  generate.addEventListener('click',()=>action(async()=>{
    // Keep the key after a lost response; a deliberate generation after a known result gets a new one.
    const id=cycleId;
    const key=pendingKeys.get(id) || crypto.randomUUID();pendingKeys.set(id,key);
    await requestJson('/api/ai/executions',{purpose:'cycle',resource_id:id,idempotency_key:key});
    if(pendingKeys.get(id)===key)pendingKeys.delete(id);
  }));
  apply.addEventListener('click',()=>action(async()=>{
    await requestJson(`/api/cycles/${encodeURIComponent(cycleId)}/planning/${encodeURIComponent(state.proposals[0].id)}/apply`,{expected_version:state.applied?.version || 0});
  }));
  cancel.addEventListener('click',()=>action(()=>requestJson(`/api/ai/executions/${encodeURIComponent(state.proposals[0].execution.id)}/cancel`,{})));
  debug.addEventListener('click',()=>action(async()=>{
    const token=generation;
    const exact=await requestJson(`/api/ai/admin/executions/${encodeURIComponent(state.proposals[0].execution.id)}`,undefined,'GET');
    if(token!==generation || modal.hidden)return;
    document.getElementById('cyclePlanningDebugOutput').textContent=JSON.stringify(exact,null,2);
    document.getElementById('cyclePlanningDebugDetails').hidden=false;
  }));
  function close(restore=true) {
    generation++;clearTimeout(timer);modal.hidden=true;trap.deactivate();busy=false;
    const target=trigger?.isConnected?trigger:[...document.querySelectorAll('[data-action=planning]')].find((button)=>button.dataset.id===cycleId);
    if(restore)target?.focus();
  }
  document.getElementById('cyclePlanningClose').addEventListener('click',()=>close());
  later.addEventListener('click',()=>close());
  retry.addEventListener('click',()=>action(async()=>{},true));
  modal.addEventListener('click',(e)=>{if(e.target===modal)close();});
  document.addEventListener('app:languagechange',()=>{const code=errorCode;render();if(code)showError({codes:[code]},readFailed,false);});
  return {close,async open(id,button,options={}){
    clearTimeout(timer);
    modal.dataset.cycleId=String(id);
    cycleId=id;trigger=button;generation++;state=null;busy=false;errorCode=null;saved=options.saved || null;readFailed=false;
    document.getElementById('cyclePlanningAdmin').hidden=true;
    generate.textContent=t('generate');generate.className='btn-primary';
    error.hidden=true;content.replaceChildren();generate.hidden=false;generate.disabled=true;apply.hidden=true;cancel.hidden=true;debug.hidden=true;
    document.getElementById('cyclePlanningDebugDetails').hidden=true;
    document.getElementById('cyclePlanningDebugOutput').textContent='';
    modal.hidden=false;render();status.textContent=t('loading');trap.activate();document.getElementById('cyclePlanningClose').focus();
    const token=generation;
    try{await refresh(token);}catch(e){if(token===generation && !modal.hidden)showError(e,true);}
  }};
}
