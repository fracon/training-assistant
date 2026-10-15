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
  let cycleId=null, trigger=null, state=null, generation=0, readSequence=0, timer=null, busy=false, key=null, errorCode=null;
  const t = (key) => translate(i18n.messages,`cyclePlanning.${key}`);
  const trap=createDialogFocusTrap(modal,close);
  const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;};
  function showError(e) {
    errorCode=e?.codes?.[0] || 'generic';
    const localized=t(`errors.${errorCode}`);
    error.textContent=localized.startsWith('cyclePlanning.')?t('errors.generic'):localized;
    error.hidden=false;error.focus();
  }
  function renderPlan(plan,heading) {
    const section=el('section',null,'cycle-plan-section');section.append(el('h3',heading));
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
    if(!state)return;
    const latest=state.proposals[0];const execution=latest?.execution;
    const running=execution && ['queued','running'].includes(execution.state);
    const candidate=execution?.state==='completed' && !latest.applied;
    generate.textContent=t(state.proposals.length?'regenerate':'generate');
    generate.className=candidate?'btn-secondary':'btn-primary';
    generate.disabled=busy || !state.available || !state.canGenerate || running;
    apply.hidden=!candidate;apply.disabled=!candidate || busy || execution?.outdated || latest.baseVersion!==(state.applied?.version || 0);
    cancel.hidden=!running;cancel.disabled=busy;
    debug.hidden=user.role!=='admin' || !execution;
    status.textContent=!state.available?t('unavailable'):!state.canGenerate?t('inactiveCycle'):latest?.applied?t('applied'):execution?t(`states.${execution.state}`):t('manualIndependent');
    content.replaceChildren();
    if(candidate) {
      if(latest.baseVersion!==(state.applied?.version || 0))content.append(el('p',t('proposalConflict'),'field-hint'));
      if(execution.outdated)content.append(el('p',t('outdated'),'field-hint'));
      renderPlan(execution.response,t('proposal'));
    }
    if(state.applied) {
      if(state.applied.outdated)content.append(el('p',t('appliedOutdated'),'field-hint'));
      renderPlan(state.applied.plan,`${t('applied')} · ${t('version')} ${state.applied.version}`);
    }
    if(!candidate && !state.applied)content.append(el('p',t('empty'),'field-hint'));
    if(execution?.error)content.append(el('p',t(`errors.${execution.error}`).startsWith('cyclePlanning.')?t('errors.generic'):t(`errors.${execution.error}`),'field-hint'));
  }
  async function refresh(token=generation) {
    const request=++readSequence;
    const result=await requestJson(`/api/cycles/${encodeURIComponent(cycleId)}/planning`,undefined,'GET');
    if(token!==generation || request!==readSequence || modal.hidden)return;
    state=result;render();clearTimeout(timer);
    if(state.proposals[0]?.execution && ['queued','running'].includes(state.proposals[0].execution.state))
      timer=setTimeout(()=>refresh(token).catch((e)=>{if(token===generation && !modal.hidden)showError(e);}),1500);
  }
  async function action(fn) {
    if(busy || !state)return;
    const token=generation;busy=true;error.hidden=true;errorCode=null;render();
    try { await fn();if(token===generation && !modal.hidden)await refresh(token); }
    catch(e){if(token===generation && !modal.hidden)showError(e);}
    finally{if(token===generation){busy=false;render();if(!modal.hidden && document.activeElement===document.body)document.getElementById('cyclePlanningClose').focus();}}
  }
  generate.addEventListener('click',()=>action(async()=>{
    // Keep the key after a lost response; a deliberate generation after a known result gets a new one.
    key ||= crypto.randomUUID();
    await requestJson('/api/ai/executions',{purpose:'cycle',resource_id:cycleId,idempotency_key:key});key=null;
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
  function close() {
    generation++;clearTimeout(timer);modal.hidden=true;trap.deactivate();busy=false;
    const target=trigger?.isConnected?trigger:[...document.querySelectorAll('[data-action=planning]')].find((button)=>button.dataset.id===cycleId);
    target?.focus();
  }
  document.getElementById('cyclePlanningClose').addEventListener('click',close);
  modal.addEventListener('click',(e)=>{if(e.target===modal)close();});
  document.addEventListener('app:languagechange',()=>{render();if(errorCode)showError({codes:[errorCode]});});
  return {async open(id,button){
    cycleId=id;trigger=button;generation++;state=null;busy=false;key=null;errorCode=null;
    error.hidden=true;content.replaceChildren();generate.disabled=true;apply.hidden=true;cancel.hidden=true;debug.hidden=true;
    document.getElementById('cyclePlanningDebugDetails').hidden=true;
    document.getElementById('cyclePlanningDebugOutput').textContent='';
    modal.hidden=false;status.textContent=t('loading');trap.activate();document.getElementById('cyclePlanningClose').focus();
    const token=generation;
    try{await refresh(token);}catch(e){if(token===generation && !modal.hidden)showError(e);}
  }};
}
