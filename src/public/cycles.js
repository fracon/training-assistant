import { initShell, getShellI18n, getUserPreferences, refreshIcons } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate as formatLocalizedDate, formatDateInput, parseLocalizedDate } from './shared/date.js';
import { createDatePicker, readDatePickerValue } from './shared/datepicker.js';
import { createDialogFocusTrap } from './shared/dialog-focus.js';
import { createExternalPromptModal } from './shared/external-prompt-modal.js';
import { createCyclePlanning } from './shared/cycle-planning.js';
import { showConfirm } from './shared/confirm-modal.js';
import {
  fetchCycles,
  createCycle,
  updateCycle,
  deleteCycle,
  requestJson,
} from './shared/api.js';

function t(messages, key) {
  return translate(messages, key);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function translateDistance(messages, distance) {
  if (!distance) return '';
  const key = `cycles.distances.${distance}`;
  const translated = t(messages, key);
  return (translated !== key && translated) ? translated : distance;
}
let promptModal = null;
let promptFocusTrap = null;
let promptOrigin = null;
let promptCopyTimer = null;
function planningActionKey(summary) {
  const status=summary?.status;
  if (status==='none' && summary.canGenerate===false) return null;
  return ({
    none: 'generate', pending: 'viewProgress', failed: 'viewDetails',
    proposal_ready: 'reviewProposal', applied_current: 'viewPlan',
    applied_outdated: 'reviewPlan', applied_incompatible: 'reviewPlan',
    unavailable: 'viewDetails', read_error: 'viewDetails',
  })[status] || 'open';
}
function planningSecondaryKey(status) {
  return ({
    new_pending: 'newPending', new_proposal_ready: 'newProposalReady',
    update_failed: 'updateFailed', unavailable: 'unavailable',
  })[status] || null;
}
function renderPlanningIndicator(card, summary, messages) {
  const indicator=card.querySelector('[data-cycle-planning-status]');
  const label=indicator?.querySelector('[data-cycle-planning-label]');
  const primary=indicator?.querySelector('[data-cycle-planning-primary]');
  const secondary=indicator?.querySelector('[data-cycle-planning-secondary]');
  const button=card.querySelector('[data-action="planning"]');
  const tooltip=button?.querySelector('.custom-tooltip');
  if (!indicator || !label || !primary || !secondary || !button || !summary?.status) return;
  label.textContent=t(messages,'cyclePlanning.cardStatus.label');
  primary.textContent=t(messages,`cyclePlanning.cardStatus.states.${summary.status}`);
  indicator.hidden=false;
  const secondaryKey=summary.secondary;
  secondary.hidden=!secondaryKey;
  secondary.textContent=secondaryKey?t(messages,`cyclePlanning.cardStatus.secondary.${planningSecondaryKey(secondaryKey)}`):'';
  const actionKey=planningActionKey(summary);
  const action=actionKey?t(messages,`cyclePlanning.cardStatus.actions.${actionKey}`):t(messages,'cyclePlanning.open');
  button.setAttribute('aria-label',action);
  tooltip.textContent=action;
}

function renderCycleCard(cycle, messages, language = 'en-US', user = null) {
  const card = document.createElement('div');
  card.className = 'cycle-card';
  card.dataset.cycleId = cycle.id;

  const title = t(messages, 'cycles.cardTitle').replace('{objective}', cycle.objective || '');
  const statusClass = `status-${cycle.status}`;
  const statusLabel = t(messages, `cycles.status.${cycle.status}`);
  const displayDistance = translateDistance(messages, cycle.distance);
  const planningStatus=cycle.planningSummary?.status;
  const actionKey=planningActionKey(cycle.planningSummary);
  const planningAction=planningStatus && actionKey ? t(messages,`cyclePlanning.cardStatus.actions.${actionKey}`) : t(messages,'cyclePlanning.open');

  card.innerHTML = `
    <div class="cycle-card-header">
      <h3 class="cycle-card-title">${escapeHtml(title)}</h3>
      <span class="cycle-status ${statusClass}">${escapeHtml(statusLabel)}</span>
    </div>
    <div class="cycle-card-meta">
      ${cycle.target_date ? `<span><strong>${t(messages, 'cycles.targetDate')}:</strong> ${escapeHtml(formatLocalizedDate(cycle.target_date, language))}</span>` : ''}
      ${displayDistance ? `<span><strong>${t(messages, 'cycles.distance')}:</strong> ${escapeHtml(displayDistance)}</span>` : ''}
      ${cycle.start_date ? `<span><strong>${t(messages, 'cycles.startDate')}:</strong> ${escapeHtml(formatLocalizedDate(cycle.start_date, language))}</span>` : ''}
      ${cycle.primary_goal ? `<span><strong>${t(messages, 'cycles.primaryGoal')}:</strong> ${escapeHtml(cycle.primary_goal)}</span>` : ''}
    </div>
    <div class="cycle-card-meta cycle-planning-indicator" data-cycle-planning-status hidden>
      <span class="cycle-planning-main"><strong data-cycle-planning-label></strong><span class="cycle-status status-completed" data-cycle-planning-primary></span></span>
      <span class="cycle-planning-secondary" data-cycle-planning-secondary hidden></span>
    </div>
    <div class="cycle-card-actions">
      ${cycle.status === 'active' ? `
        <button type="button" class="btn-icon cycle-edit-btn" data-action="edit" data-id="${cycle.id}" aria-label="${t(messages, 'cycles.edit')}">
          <i data-lucide="pencil"></i>
          <div class="custom-tooltip" data-i18n="cycles.editTooltip">${escapeHtml(t(messages, 'cycles.editTooltip'))}</div>
        </button>
        <button type="button" class="btn-icon btn-ok cycle-complete-btn" data-action="complete" data-id="${cycle.id}" aria-label="${t(messages, 'cycles.complete')}">
          <i data-lucide="check-circle"></i>
          <div class="custom-tooltip" data-i18n="cycles.completeTooltip">${escapeHtml(t(messages, 'cycles.completeTooltip'))}</div>
        </button>
        <button type="button" class="btn-icon btn-warn cycle-cancel-btn" data-action="cancel" data-id="${cycle.id}" aria-label="${t(messages, 'cycles.cancel')}">
          <i data-lucide="x-circle"></i>
          <div class="custom-tooltip" data-i18n="cycles.cancelTooltip">${escapeHtml(t(messages, 'cycles.cancelTooltip'))}</div>
        </button>
      ` : ''}
      ${cycle.status === 'active' && user?.role === 'admin' ? `
        <button type="button" class="btn-icon cycle-prompt-btn" data-action="prompt" data-id="${cycle.id}" aria-label="${t(messages, 'cycles.generatePrompt')}">
          <i data-lucide="sparkles"></i>
          <div class="custom-tooltip" data-i18n="cycles.promptTooltip">${escapeHtml(t(messages, 'cycles.promptTooltip'))}</div>
        </button>
      ` : ''}
      <button type="button" class="btn-icon" data-action="planning" data-id="${cycle.id}" aria-label="${escapeHtml(planningAction)}">
        <i data-lucide="calendar-range" aria-hidden="true"></i>
        <div class="custom-tooltip">${escapeHtml(planningAction)}</div>
      </button>
    </div>`;
  renderPlanningIndicator(card,cycle.planningSummary,messages);
  return card;
}

function renderList(cycles, messages, language = 'en-US', user = null) {
  const listEl = document.getElementById('cycleList');
  const emptyEl = document.getElementById('cycleEmpty');
  listEl.innerHTML = '';

  if (cycles.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  for (const cycle of cycles) {
    listEl.appendChild(renderCycleCard(cycle, messages, language, user));
  }
  refreshIcons();
}

function openModal(mode, cycle, messages, language = 'en-US') {
  const modal = document.getElementById('cycleModal');
  const titleEl = document.getElementById('cycleModalTitle');
  const form = document.getElementById('cycleForm');
  const saveLabel = document.getElementById('cycleSaveLabel');
  const cancelBtn = document.getElementById('cycleCancelBtn');
  const errorEl = document.getElementById('cycleFormError');

  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  form.dataset.mode = mode;
  form.dataset.cycleId = cycle ? cycle.id : '';

  if (mode === 'edit') {
    titleEl.setAttribute('data-i18n', 'cycles.formTitleEdit');
    titleEl.textContent = t(messages, 'cycles.formTitleEdit');
    document.getElementById('cycleObjective').value = cycle.objective ?? '';
    setDateInput('cycleTargetDate', cycle.target_date, language);
    document.getElementById('cycleDistance').value = cycle.distance ?? '';
    document.getElementById('cycleRunBefore').value = cycle.run_before ?? '';
    document.getElementById('cycleRunCount').value = cycle.run_count ?? '';
    setDateInput('cycleStartDate', cycle.start_date, language);
    document.getElementById('cyclePrimaryGoal').value = cycle.primary_goal ?? '';
    document.getElementById('cycleSecondaryGoal').value = cycle.secondary_goal ?? '';
    document.getElementById('cycleOtherEvents').value = cycle.other_events ?? '';
  } else {
    titleEl.setAttribute('data-i18n', 'cycles.formTitleAdd');
    titleEl.textContent = t(messages, 'cycles.formTitleAdd');
    form.reset();
    setDateInput('cycleTargetDate', '', language);
    setDateInput('cycleStartDate', '', language);
  }

  saveLabel.setAttribute('data-i18n', 'cycles.saveCycle');
  saveLabel.textContent = t(messages, 'cycles.saveCycle');
  cancelBtn.setAttribute('data-i18n', 'cycles.cancelForm');
  cancelBtn.textContent = t(messages, 'cycles.cancelForm');

  modal.classList.remove('hidden');
  document.getElementById('cycleObjective').focus();
}

function setDateInput(id, iso, language) {
  const input = document.getElementById(id);
  if (!input) return;
  if (input.datePicker) {
    input.datePicker.setValue(iso || '');
    return;
  }
  input.dataset.iso = iso || '';
  input.value = iso ? formatDateInput(iso, language) : '';
  input.placeholder = language === 'pt-BR' ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
}

function readDateInput(id, language) {
  const input = document.getElementById(id);
  if (!input) return null;
  if (input.datePicker) return readDatePickerValue(input);
  const iso = parseLocalizedDate(input.value, language);
  input.dataset.iso = iso;
  return iso || null;
}

function closeModal() {
  document.getElementById('cycleModal').classList.add('hidden');
}

function showFormError(messageKey, messages) {
  const errorEl = document.getElementById('cycleFormError');
  errorEl.textContent = t(messages, messageKey);
  errorEl.classList.remove('hidden');
}

function showPromptModal(text, trigger) {
  if (!promptModal || !text) return;
  promptOrigin = trigger;
  promptModal.setPrompt(text);
  promptModal.setStatus('');
  promptModal.dialog.hidden = false;
  promptFocusTrap.activate();
  promptModal.closeButton.focus();
  refreshIcons();
}

function hidePromptModal() {
  if (!promptModal || promptModal.dialog.hidden) return;
  promptModal.dialog.hidden = true;
  promptFocusTrap.deactivate();
  clearTimeout(promptCopyTimer);
  promptCopyTimer = null;
  promptModal.setStatus('');
  const origin = promptOrigin;
  promptOrigin = null;
  if (origin?.isConnected && !origin.disabled) origin.focus();
}

function showToast(messages, messageKey, duration = 2500, type = 'success') {
  const toast = document.getElementById('toast');
  const iconEl = toast.querySelector('.toast-icon');
  const textEl = toast.querySelector('.toast-text');
  const iconName = type === 'error' ? 'x-circle' : 'check-circle';
  iconEl.innerHTML = `<i data-lucide="${iconName}"></i>`;
  toast.classList.toggle('toast-error', type === 'error');
  textEl.textContent = t(messages, messageKey);
  toast.classList.add('visible');
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [toast] });
  setTimeout(() => toast.classList.remove('visible'), duration);
}

function planningButton(id) {
  return [...document.querySelectorAll('[data-action="planning"]')].find((button) => button.dataset.id === String(id));
}

function createCycleFormFlow({ i18n, planning, onSaved }) {
  const modal = document.getElementById('cycleModal');
  const form = document.getElementById('cycleForm');
  const save = document.getElementById('cycleSaveBtn');
  let revision = 0, saving = false, trigger = null;
  const trap = createDialogFocusTrap(modal, () => {
    const picker = modal.querySelector('input[aria-expanded="true"]');
    if (picker) { picker.datePicker.destroy();return; }
    close();
  });
  function close(restore = true) {
    if (modal.classList.contains('hidden')) return;
    revision++;
    closeModal();trap.deactivate();
    if (restore) {
      const target = trigger?.isConnected && !trigger.disabled ? trigger : planningButton(form.dataset.cycleId) || document.getElementById('addCycleBtn');
      if (!target.disabled) target.focus();
    }
  }
  return {
    open(mode, cycle, button) {
      planning.close(false);revision++;trigger = button;
      openModal(mode, cycle, i18n.messages, i18n.language);
      save.disabled = saving;trap.activate();document.getElementById('cycleObjective').focus();
    },
    close,
    begin() {
      if (saving || modal.classList.contains('hidden')) return null;
      saving = true;save.disabled = true;
      document.getElementById('cycleFormError').classList.add('hidden');
      document.getElementById('cycleFormError').textContent='';
      document.getElementById('cycleSaveLabel').textContent = t(i18n.messages, 'cycles.saving');
      return revision;
    },
    current(token) { return token === revision && !modal.classList.contains('hidden'); },
    finish() {
      saving = false;save.disabled = false;
      document.getElementById('cycleSaveLabel').textContent = t(i18n.messages, 'cycles.saveCycle');
    },
    record: onSaved,
  };
}

async function handleSubmit(i18n, formFlow, planning) {
  const form = document.getElementById('cycleForm');
  const mode = form.dataset.mode;
  const id = form.dataset.cycleId;
  const { messages, language } = i18n;
  const objective = document.getElementById('cycleObjective').value.trim();
  if (!objective) {
    showFormError('cycles.errors.objectiveRequired', messages);
    return;
  }
  const token = formFlow.begin();
  if (token === null) return;

  const payload = {
    objective,
    target_date: readDateInput('cycleTargetDate', language),
    distance: document.getElementById('cycleDistance').value || null,
    run_before: document.getElementById('cycleRunBefore').value || null,
    run_count: document.getElementById('cycleRunCount').value || null,
    start_date: readDateInput('cycleStartDate', language),
    primary_goal: document.getElementById('cyclePrimaryGoal').value || null,
    secondary_goal: document.getElementById('cycleSecondaryGoal').value || null,
    other_events: document.getElementById('cycleOtherEvents').value || null,
  };

  let result;
  try {
    result = mode === 'add' ? await createCycle(payload) : await updateCycle(id, payload);
    if (!result?.cycle?.id) throw new Error('Missing saved cycle.');
  } catch {
    if (formFlow.current(token)) showFormError('cycles.errors.save', i18n.messages);
    formFlow.finish();
    return;
  }

  // The write response is canonical. A later read cannot turn this into a failed
  // save or discard the only card from which the person can resume planning.
  const saved = result.cycle;
  const button = formFlow.record(saved);
  window.dispatchEvent(new CustomEvent('kinesis:cycle-changed'));
  if (!formFlow.current(token)) { formFlow.finish();return; }
  showToast(i18n.messages, mode === 'add' ? 'cycles.success.add' : 'cycles.success.edit');
  formFlow.close(false);formFlow.finish();
  if (saved.status === 'active') planning.open(saved.id, button, { saved: mode });
  else button?.focus();
}

async function handleAction(action, id, cycles, messages, language = 'en-US', user = null, formFlow, button) {
  if (action === 'edit') {
    const cycle = cycles.find((c) => String(c.id) === String(id));
    if (cycle) formFlow.open('edit', cycle, button);
    return;
  }

  if (action === 'complete') {
    if (!(await showConfirm({
      title: t(messages, 'cycles.complete'),
      message: t(messages, 'cycles.completeConfirm'),
      icon: 'check-circle',
      confirmText: t(messages, 'cycles.complete'),
      cancelText: t(messages, 'cycles.confirm.no'),
      confirmButtonClass: 'btn-primary',
      onConfirm: () => updateCycle(id, { status: 'completed' }),
    }))) return;
    const updated = await fetchCycles();
    cycles.length = 0;
    cycles.push(...updated);
    renderList(cycles, messages, language, user);
    window.dispatchEvent(new CustomEvent('kinesis:cycle-changed'));
    return;
  }

  if (action === 'cancel') {
    if (!(await showConfirm({
      title: t(messages, 'cycles.cancelTitle'),
      message: t(messages, 'cycles.deleteConfirm'),
      icon: 'trash-2',
      confirmText: t(messages, 'cycles.confirm.yes'),
      cancelText: t(messages, 'cycles.confirm.no'),
      confirmButtonClass: 'btn-danger',
      onConfirm: () => updateCycle(id, { status: 'cancelled' }),
    }))) return;
    const updated = await fetchCycles();
    cycles.length = 0;
    cycles.push(...updated);
    renderList(cycles, messages, language, user);
    showToast(messages, 'cycles.success.delete');
    window.dispatchEvent(new CustomEvent('kinesis:cycle-changed'));
    return;
  }

  if (action === 'prompt' && user?.role === 'admin') {
    try {
      const lng = (getShellI18n().language === 'pt-BR') ? 'pt' : 'en';
      const result = await requestJson(`/api/cycles/${id}/prompt?lng=${lng}`, null, 'GET');
      if (result.prompt) showPromptModal(result.prompt, button);
    } catch (error) {
      console.error('Prompt generation failed:', error);
      showToast(messages, 'cycles.errors.prompt', 2500, 'error');
    }
  }
}

async function handleCopyPrompt(messages) {
  if (!promptModal) return;
  const text = promptModal.output.value;
  try {
    await navigator.clipboard.writeText(text);
    promptModal.setStatus(t(messages, 'aiCoach.promptCopied'));
    clearTimeout(promptCopyTimer);
    promptCopyTimer = setTimeout(() => {
      if (!promptModal.dialog.hidden) promptModal.setStatus('');
    }, 2000);
  } catch {
    promptModal.output.select();
    showToast(messages, 'cycles.errors.clipboard', 2500, 'error');
  }
}

export async function initCyclesPage() {
  const user = await initShell({ active: 'cycles' });
  if (!user) return null;

  const i18n = getShellI18n();
  const promptRoot = document.getElementById('promptModal');
  if (user.role === 'admin') {
    promptModal = createExternalPromptModal({
      root: promptRoot,
      id: 'promptModal',
      titleId: 'cyclePromptTitle',
      title: t(i18n.messages, 'cycles.promptTitle'),
      closeLabel: t(i18n.messages, 'session.analysis.close'),
      copyLabel: t(i18n.messages, 'session.analysis.copyPrompt'),
      closeButtonId: 'promptCloseBtn',
      closeActionId: 'promptCloseAction',
      copyButtonId: 'promptCopyBtn',
      outputId: 'promptOutput',
      statusId: 'promptCopyStatus',
    });
    promptFocusTrap = createDialogFocusTrap(promptModal.dialog, hidePromptModal);
  }
  const cycles = [];
  let listRevision = 0, activeRead = 0, summaryEpoch = 0, summaryRead = 0, summaryTimer = null;
  const pendingSummaryCycles = new Set();
  const planningModal=document.getElementById('cyclePlanningModal');
  const summaryIsPending=(summary)=>summary?.status==='pending' || summary?.secondary==='new_pending';
  function schedulePlanningSummaryRead() {
    clearTimeout(summaryTimer);
    if (!planningModal.hidden || document.visibilityState==='hidden' ||
        (!pendingSummaryCycles.size && !cycles.some((cycle)=>summaryIsPending(cycle.planningSummary)))) return;
    summaryTimer=setTimeout(async()=>{
      const request=++summaryRead, epoch=summaryEpoch;
      if (!planningModal.hidden || document.visibilityState==='hidden') {
        schedulePlanningSummaryRead();
        return;
      }
      try {
        const result=await requestJson('/api/cycles',undefined,'GET');
        if(request!==summaryRead || epoch!==summaryEpoch || planningModal.hidden===false) return;
        const latest=new Map(result.cycles.map((cycle)=>[String(cycle.id),cycle.planningSummary]));
        for (const id of [...pendingSummaryCycles]) if (!latest.has(id)) pendingSummaryCycles.delete(id);
        for(const cycle of cycles) {
          const summary=latest.get(String(cycle.id));
          if(summary) {
            if(summary.status==='read_error' && cycle.planningSummary?.status && cycle.planningSummary.status!=='read_error') continue;
            cycle.planningSummary=summary;
            if(summaryIsPending(summary))pendingSummaryCycles.add(String(cycle.id));
            else pendingSummaryCycles.delete(String(cycle.id));
            const card=[...cycleListEl.querySelectorAll('.cycle-card')].find((item)=>item.dataset.cycleId===String(cycle.id));
            if(card)renderPlanningIndicator(card,summary,i18n.messages);
          }
        }
      } catch { /* A read failure keeps the last confirmed summary. */ }
      schedulePlanningSummaryRead();
    },3000);
  }
  const planning = createCyclePlanning({i18n,user,onSummaryChange(id,summary){
    if (!summary?.status) return;
    summaryEpoch++;
    if(summaryIsPending(summary))pendingSummaryCycles.add(String(id));
    else pendingSummaryCycles.delete(String(id));
    const cycle=cycles.find((item)=>String(item.id)===String(id));
    if (cycle) cycle.planningSummary=summary;
    const card=[...cycleListEl.querySelectorAll('.cycle-card')].find((item)=>item.dataset.cycleId===String(id));
    if (card) renderPlanningIndicator(card,summary,i18n.messages);
  },onGenerationRequested(id){pendingSummaryCycles.add(String(id));schedulePlanningSummaryRead();},onOpen(){clearTimeout(summaryTimer);summaryRead++;},onClose(){schedulePlanningSummaryRead();}});

  const addBtn = document.getElementById('addCycleBtn');
  const modalCloseBtn = document.getElementById('cycleModalCloseBtn');
  const formCancelBtn = document.getElementById('cycleCancelBtn');
  const form = document.getElementById('cycleForm');
  const cycleListEl = document.getElementById('cycleList');

  const formFlow = createCycleFormFlow({ i18n, planning, onSaved(saved) {
    listRevision++;
    const index = cycles.findIndex((cycle) => cycle.id === saved.id);
    if (index === -1) cycles.unshift(saved);else cycles[index] = saved;
    renderList(cycles, i18n.messages, i18n.language, user);
    setActiveButton(cycles.some((cycle) => cycle.status === 'active'));
    return planningButton(saved.id);
  }});
  document.addEventListener('visibilitychange',schedulePlanningSummaryRead);
  function setActiveButton(active) {
    addBtn.disabled = active;
    addBtn.closest('.add-cycle-wrapper').querySelector('.custom-tooltip').textContent = active ? t(i18n.messages, 'cycles.disabledTooltip') : '';
  }
  async function checkActiveCycle() {
    const request = ++activeRead, revision = listRevision;
    try {
      const result = await requestJson('/api/cycles/active', undefined, 'GET');
      if (request === activeRead && revision === listRevision) setActiveButton(Boolean(result.cycle));
    } catch { /* Keep the last confirmed state, including a newly saved active cycle. */ }
  }

  for (const id of ['cycleTargetDate', 'cycleStartDate']) {
    createDatePicker(document.getElementById(id), {
      getLanguage: () => i18n.language,
      getWeekStart: () => getUserPreferences().first_day_of_week,
    });
  }

  addBtn.addEventListener('click', () => formFlow.open('add', null, addBtn));
  modalCloseBtn.addEventListener('click', () => formFlow.close());
  formCancelBtn.addEventListener('click', () => formFlow.close());

  document.getElementById('cycleModal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) formFlow.close();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSubmit(i18n, formFlow, planning);
  });

  cycleListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'planning') { formFlow.close(false);planning.open(btn.dataset.id,btn);return; }
    handleAction(btn.dataset.action, btn.dataset.id, cycles, i18n.messages, i18n.language, user, formFlow, btn);
  });

  if (user.role === 'admin') {
    document.getElementById('promptCloseBtn').addEventListener('click', hidePromptModal);
    document.getElementById('promptCloseAction').addEventListener('click', hidePromptModal);
    document.getElementById('promptCopyBtn').addEventListener('click', () => handleCopyPrompt(i18n.messages));
    document.getElementById('promptModal').addEventListener('click', (e) => {
      if (e.target === promptModal.dialog) hidePromptModal();
    });
  } else {
    promptRoot.remove();
  }

  document.addEventListener('app:languagechange', () => {
    const msgs = i18n.messages;
    document.title = translate(msgs, 'cycles.pageTitle');
    renderList(cycles, msgs, i18n.language, user);
    for (const id of ['cycleTargetDate', 'cycleStartDate']) {
      const input = document.getElementById(id);
      const iso = input.dataset.iso || parseLocalizedDate(input.value, i18n.language);
      setDateInput(id, iso, i18n.language);
      input.placeholder = i18n.language === 'pt-BR' ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
    }
    checkActiveCycle();

    const modal = document.getElementById('cycleModal');
    if (!modal.classList.contains('hidden')) {
      const titleEl = document.getElementById('cycleModalTitle');
      const saveLabel = document.getElementById('cycleSaveLabel');
      const cancelBtn = document.getElementById('cycleCancelBtn');
      const i18nKey = titleEl.getAttribute('data-i18n');
      titleEl.textContent = translate(msgs, i18nKey);
      saveLabel.textContent = translate(msgs, 'cycles.saveCycle');
      cancelBtn.textContent = translate(msgs, 'cycles.cancelForm');
    }

    if (promptModal) {
      promptModal.setLabels({
        title: translate(msgs, 'cycles.promptTitle'),
        close: translate(msgs, 'session.analysis.close'),
        copy: translate(msgs, 'session.analysis.copyPrompt'),
      });
      if (!promptModal.dialog.hidden && promptModal.status.textContent)
        promptModal.setStatus(translate(msgs, 'aiCoach.promptCopied'));
    }
  });

  try {
    const revision = listRevision;
    const fetched = await fetchCycles();
    if (revision === listRevision) { cycles.push(...fetched);renderList(cycles, i18n.messages, i18n.language, user);schedulePlanningSummaryRead(); }
  } catch { /* load failed — non-critical */ }

  await checkActiveCycle();

  window.addEventListener('kinesis:cycle-changed', () => checkActiveCycle());

  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initCyclesPage().catch(() => window.location.replace('/login.html'));
}
