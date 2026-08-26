import { initShell, getShellI18n, refreshIcons, showConfirm } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import {
  fetchCycles,
  fetchActiveCycle,
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

function renderCycleCard(cycle, messages) {
  const card = document.createElement('div');
  card.className = 'cycle-card';
  card.dataset.cycleId = cycle.id;

  const title = t(messages, 'cycles.cardTitle').replace('{objective}', cycle.objective || '');
  const statusClass = `status-${cycle.status}`;
  const statusLabel = t(messages, `cycles.status.${cycle.status}`);
  const displayDistance = translateDistance(messages, cycle.distance);

  card.innerHTML = `
    <div class="cycle-card-header">
      <h3 class="cycle-card-title">${escapeHtml(title)}</h3>
      <span class="cycle-status ${statusClass}">${escapeHtml(statusLabel)}</span>
    </div>
    <div class="cycle-card-meta">
      ${cycle.target_date ? `<span><strong>${t(messages, 'cycles.targetDate')}:</strong> ${escapeHtml(cycle.target_date)}</span>` : ''}
      ${displayDistance ? `<span><strong>${t(messages, 'cycles.distance')}:</strong> ${escapeHtml(displayDistance)}</span>` : ''}
      ${cycle.start_date ? `<span><strong>${t(messages, 'cycles.startDate')}:</strong> ${escapeHtml(cycle.start_date)}</span>` : ''}
      ${cycle.primary_goal ? `<span><strong>${t(messages, 'cycles.primaryGoal')}:</strong> ${escapeHtml(cycle.primary_goal)}</span>` : ''}
    </div>
    <div class="cycle-card-actions">
      ${cycle.status === 'active' ? `
        <button type="button" class="btn-icon cycle-edit-btn" data-action="edit" data-id="${cycle.id}" aria-label="${t(messages, 'cycles.edit')}">
          <i data-lucide="pencil"></i>
        </button>
        <button type="button" class="btn-icon btn-ok cycle-complete-btn" data-action="complete" data-id="${cycle.id}" aria-label="${t(messages, 'cycles.complete')}">
          <i data-lucide="check-circle"></i>
        </button>
        <button type="button" class="btn-icon btn-warn cycle-cancel-btn" data-action="cancel" data-id="${cycle.id}" aria-label="${t(messages, 'cycles.cancel')}">
          <i data-lucide="x-circle"></i>
        </button>
        <button type="button" class="btn-icon cycle-prompt-btn" data-action="prompt" data-id="${cycle.id}" aria-label="${t(messages, 'cycles.generatePrompt')}">
          <i data-lucide="sparkles"></i>
        </button>
      ` : ''}
    </div>`;
  return card;
}

function renderList(cycles, messages) {
  const listEl = document.getElementById('cycleList');
  const emptyEl = document.getElementById('cycleEmpty');
  listEl.innerHTML = '';

  if (cycles.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  for (const cycle of cycles) {
    listEl.appendChild(renderCycleCard(cycle, messages));
  }
  refreshIcons();
}

function openModal(mode, cycle, messages) {
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
    document.getElementById('cycleTargetDate').value = cycle.target_date ?? '';
    document.getElementById('cycleDistance').value = cycle.distance ?? '';
    document.getElementById('cycleRunBefore').value = cycle.run_before ?? '';
    document.getElementById('cycleRunCount').value = cycle.run_count ?? '';
    document.getElementById('cycleStartDate').value = cycle.start_date ?? '';
    document.getElementById('cyclePrimaryGoal').value = cycle.primary_goal ?? '';
    document.getElementById('cycleSecondaryGoal').value = cycle.secondary_goal ?? '';
    document.getElementById('cycleOtherEvents').value = cycle.other_events ?? '';
  } else {
    titleEl.setAttribute('data-i18n', 'cycles.formTitleAdd');
    titleEl.textContent = t(messages, 'cycles.formTitleAdd');
    form.reset();
  }

  saveLabel.setAttribute('data-i18n', 'cycles.saveCycle');
  saveLabel.textContent = t(messages, 'cycles.saveCycle');
  cancelBtn.setAttribute('data-i18n', 'cycles.cancelForm');
  cancelBtn.textContent = t(messages, 'cycles.cancelForm');

  modal.classList.remove('hidden');
  document.getElementById('cycleObjective').focus();
}

function closeModal() {
  document.getElementById('cycleModal').classList.add('hidden');
}

function showFormError(messageKey, messages) {
  const errorEl = document.getElementById('cycleFormError');
  errorEl.textContent = t(messages, messageKey);
  errorEl.classList.remove('hidden');
}

function showPromptModal(text, messages) {
  const modal = document.getElementById('promptModal');
  const output = document.getElementById('promptOutput');
  output.textContent = text;
  modal.classList.remove('hidden');
  refreshIcons();
}

function hidePromptModal() {
  document.getElementById('promptModal').classList.add('hidden');
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

async function handleSubmit(cycles, messages) {
  const form = document.getElementById('cycleForm');
  const mode = form.dataset.mode;
  const objective = document.getElementById('cycleObjective').value.trim();

  if (!objective) {
    showFormError('cycles.errors.objectiveRequired', messages);
    return;
  }

  const payload = {
    objective,
    target_date: document.getElementById('cycleTargetDate').value || null,
    distance: document.getElementById('cycleDistance').value || null,
    run_before: document.getElementById('cycleRunBefore').value || null,
    run_count: document.getElementById('cycleRunCount').value || null,
    start_date: document.getElementById('cycleStartDate').value || null,
    primary_goal: document.getElementById('cyclePrimaryGoal').value || null,
    secondary_goal: document.getElementById('cycleSecondaryGoal').value || null,
    other_events: document.getElementById('cycleOtherEvents').value || null,
  };

  const saveBtn = document.getElementById('cycleSaveBtn');
  const saveLabel = document.getElementById('cycleSaveLabel');
  saveBtn.disabled = true;
  saveLabel.textContent = t(messages, 'cycles.saving');

  try {
    if (mode === 'add') {
      const result = await createCycle(payload);
      closeModal();
      const updated = await fetchCycles();
      cycles.length = 0;
      cycles.push(...updated);
      renderList(cycles, messages);
      showToast(messages, 'cycles.success.add');
      window.dispatchEvent(new CustomEvent('kinesis:cycle-changed'));
      if (result.cycle) {
        try {
          const promptResult = await requestJson(`/api/cycles/${result.cycle.id}/prompt`, null, 'GET');
          if (promptResult.prompt) showPromptModal(promptResult.prompt, messages);
        } catch { /* prompt fetch failed — non-critical */ }
      }
    } else {
      await updateCycle(form.dataset.cycleId, payload);
      closeModal();
      const updated = await fetchCycles();
      cycles.length = 0;
      cycles.push(...updated);
      renderList(cycles, messages);
      showToast(messages, 'cycles.success.edit');
    }
  } catch {
    showFormError('cycles.errors.save', messages);
  } finally {
    saveBtn.disabled = false;
    saveLabel.textContent = t(messages, 'cycles.saveCycle');
  }
}

async function handleAction(action, id, cycles, messages) {
  if (action === 'edit') {
    const cycle = cycles.find((c) => String(c.id) === String(id));
    if (cycle) openModal('edit', cycle, messages);
    return;
  }

  if (action === 'complete') {
    await updateCycle(id, { status: 'completed' });
    const updated = await fetchCycles();
    cycles.length = 0;
    cycles.push(...updated);
    renderList(cycles, messages);
    window.dispatchEvent(new CustomEvent('kinesis:cycle-changed'));
    return;
  }

  if (action === 'cancel') {
    if (!(await showConfirm(
      t(messages, 'cycles.deleteConfirm'),
      t(messages, 'cycles.confirm.yes'),
      t(messages, 'cycles.confirm.no'),
    ))) return;
    await updateCycle(id, { status: 'cancelled' });
    const updated = await fetchCycles();
    cycles.length = 0;
    cycles.push(...updated);
    renderList(cycles, messages);
    showToast(messages, 'cycles.success.delete');
    window.dispatchEvent(new CustomEvent('kinesis:cycle-changed'));
    return;
  }

  if (action === 'prompt') {
    try {
      const lng = (getShellI18n().language === 'pt-BR') ? 'pt' : 'en';
      const result = await requestJson(`/api/cycles/${id}/prompt?lng=${lng}`, null, 'GET');
      if (result.prompt) showPromptModal(result.prompt, messages);
    } catch (error) {
      console.error('Prompt generation failed:', error);
      showToast(messages, 'cycles.errors.prompt', 2500, 'error');
    }
  }
}

async function handleCopyPrompt(messages) {
  const output = document.getElementById('promptOutput');
  try {
    await navigator.clipboard.writeText(output.textContent);
    const btn = document.getElementById('promptCopyBtn');
    const span = btn.querySelector('span');
    span.textContent = t(messages, 'aiCoach.copied');
    setTimeout(() => { span.textContent = t(messages, 'cycles.copyPrompt'); }, 2000);
  } catch { /* clipboard unavailable */ }
}

async function checkActiveCycle(addBtn, messages) {
  const activeCycle = await fetchActiveCycle();
  const tooltip = addBtn.closest('.add-cycle-wrapper').querySelector('.custom-tooltip');
  if (activeCycle) {
    addBtn.disabled = true;
    tooltip.textContent = t(messages, 'cycles.disabledTooltip');
  } else {
    addBtn.disabled = false;
    tooltip.textContent = '';
  }
}

export async function initCyclesPage() {
  const user = await initShell({ active: 'cycles' });
  if (!user) return null;

  const i18n = getShellI18n();
  const cycles = [];

  const addBtn = document.getElementById('addCycleBtn');
  const modalCloseBtn = document.getElementById('cycleModalCloseBtn');
  const formCancelBtn = document.getElementById('cycleCancelBtn');
  const form = document.getElementById('cycleForm');
  const cycleListEl = document.getElementById('cycleList');

  addBtn.addEventListener('click', () => openModal('add', null, i18n.messages));
  modalCloseBtn.addEventListener('click', closeModal);
  formCancelBtn.addEventListener('click', closeModal);

  document.getElementById('cycleModal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSubmit(cycles, i18n.messages);
  });

  cycleListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    handleAction(btn.dataset.action, btn.dataset.id, cycles, i18n.messages);
  });

  document.getElementById('promptCloseBtn').addEventListener('click', hidePromptModal);
  document.getElementById('promptCopyBtn').addEventListener('click', () => handleCopyPrompt(i18n.messages));
  document.getElementById('promptModal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) hidePromptModal();
  });

  document.addEventListener('app:languagechange', () => {
    const msgs = i18n.messages;
    document.title = translate(msgs, 'cycles.pageTitle');
    renderList(cycles, msgs);
    checkActiveCycle(addBtn, msgs);

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

    const promptModal = document.getElementById('promptModal');
    if (!promptModal.classList.contains('hidden')) {
      const copyLabel = document.querySelector('#promptCopyBtn span');
      if (copyLabel) copyLabel.textContent = translate(msgs, 'cycles.copyPrompt');
    }
  });

  try {
    const fetched = await fetchCycles();
    cycles.push(...fetched);
    renderList(cycles, i18n.messages);
  } catch { /* load failed — non-critical */ }

  await checkActiveCycle(addBtn, i18n.messages);

  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initCyclesPage().catch(() => window.location.replace('/login.html'));
}
