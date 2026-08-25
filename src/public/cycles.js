import { initShell, getShellI18n } from './shared/shell.js';
import {
  fetchCycles,
  fetchActiveCycle,
  createCycle,
  updateCycle,
  deleteCycle,
  requestJson,
} from './shared/api.js';

let currentLang = 'en-US';

function t(key) {
  const i18n = getShellI18n();
  return i18n?.messages?.[key] ?? key;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderCycleCard(cycle) {
  const card = document.createElement('div');
  card.className = 'cycle-card';
  card.dataset.cycleId = cycle.id;

  const title = t('cycles.cardTitle').replace('{objective}', cycle.objective || '');

  const statusClass = `status-${cycle.status}`;
  const statusLabel = t(`cycles.status.${cycle.status}`);

  card.innerHTML = `
    <div class="cycle-card-header">
      <h3 class="cycle-card-title">${escapeHtml(title)}</h3>
      <span class="cycle-status ${statusClass}">${escapeHtml(statusLabel)}</span>
    </div>
    <div class="cycle-card-meta">
      ${cycle.target_date ? `<span><strong>${t('cycles.targetDate')}:</strong> ${escapeHtml(cycle.target_date)}</span>` : ''}
      ${cycle.distance ? `<span><strong>${t('cycles.distance')}:</strong> ${escapeHtml(cycle.distance)}</span>` : ''}
      ${cycle.start_date ? `<span><strong>${t('cycles.startDate')}:</strong> ${escapeHtml(cycle.start_date)}</span>` : ''}
      ${cycle.primary_goal ? `<span><strong>${t('cycles.primaryGoal')}:</strong> ${escapeHtml(cycle.primary_goal)}</span>` : ''}
    </div>
    <div class="cycle-card-actions">
      ${cycle.status === 'active' ? `
        <button class="icon-btn cycle-edit-btn" data-id="${cycle.id}" title="${t('cycles.edit')}">
          <i data-lucide="pencil"></i>
        </button>
        <button class="icon-btn cycle-complete-btn" data-id="${cycle.id}" title="${t('cycles.complete')}">
          <i data-lucide="check-circle"></i>
        </button>
        <button class="icon-btn cycle-cancel-btn" data-id="${cycle.id}" title="${t('cycles.cancel')}">
          <i data-lucide="x-circle"></i>
        </button>
        <button class="icon-btn cycle-prompt-btn" data-id="${cycle.id}" title="${t('cycles.generatePrompt')}">
          <i data-lucide="sparkles"></i>
        </button>
      ` : ''}
    </div>
  `;
  return card;
}

async function loadCycles() {
  const list = document.getElementById('cycleList');
  const cycles = await fetchCycles();
  list.innerHTML = '';
  if (cycles.length === 0) {
    list.innerHTML = `<p class="empty-state">${t('cycles.empty')}</p>`;
    return;
  }
  for (const cycle of cycles) {
    list.appendChild(renderCycleCard(cycle));
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function checkActiveCycle() {
  const activeCycle = await fetchActiveCycle();
  const addBtn = document.getElementById('addCycleBtn');
  if (activeCycle) {
    addBtn.disabled = true;
    addBtn.setAttribute('data-i18n-title', 'cycles.disabledTooltip');
    addBtn.title = t('cycles.disabledTooltip');
  } else {
    addBtn.disabled = false;
    addBtn.removeAttribute('data-i18n-title');
    addBtn.title = '';
  }
}

function showPromptModal(text) {
  const modal = document.getElementById('promptModal');
  const output = document.getElementById('promptOutput');
  output.textContent = text;
  modal.classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function hidePromptModal() {
  document.getElementById('promptModal').classList.add('hidden');
}

function showAddForm() {
  const list = document.getElementById('cycleList');
  const existing = list.querySelector('.cycle-form');
  if (existing) existing.remove();

  const form = document.createElement('div');
  form.className = 'cycle-form';
  form.innerHTML = `
    <div class="cycle-form-grid">
      <div class="field">
        <label class="field-label" for="cycleObjective">${t('cycles.objective')}</label>
        <input type="text" id="cycleObjective" class="input-control" placeholder="${t('cycles.objectivePlaceholder')}" required>
      </div>
      <div class="field">
        <label class="field-label" for="cycleTargetDate">${t('cycles.targetDate')}</label>
        <input type="date" id="cycleTargetDate" class="input-control">
      </div>
      <div class="field">
        <label class="field-label" for="cycleDistance">${t('cycles.distance')}</label>
        <input type="text" id="cycleDistance" class="input-control" placeholder="e.g. Marathon, 10K">
      </div>
      <div class="field">
        <label class="field-label" for="cycleRunBefore">${t('cycles.runBefore')}</label>
        <select id="cycleRunBefore" class="input-control">
          <option value="">–</option>
          <option value="Sim">${t('common.yes')}</option>
          <option value="Não">${t('common.no')}</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="cycleRunCount">${t('cycles.runCount')}</label>
        <input type="number" id="cycleRunCount" class="input-control" min="0">
      </div>
      <div class="field">
        <label class="field-label" for="cycleStartDate">${t('cycles.startDate')}</label>
        <input type="date" id="cycleStartDate" class="input-control">
      </div>
      <div class="field">
        <label class="field-label" for="cyclePrimaryGoal">${t('cycles.primaryGoal')}</label>
        <input type="text" id="cyclePrimaryGoal" class="input-control">
      </div>
      <div class="field">
        <label class="field-label" for="cycleSecondaryGoal">${t('cycles.secondaryGoal')}</label>
        <input type="text" id="cycleSecondaryGoal" class="input-control">
      </div>
      <div class="field field-wide">
        <label class="field-label" for="cycleOtherEvents">${t('cycles.otherEvents')}</label>
        <textarea id="cycleOtherEvents" rows="2" class="input-control"></textarea>
      </div>
    </div>
    <div class="cycle-form-actions">
      <button type="button" class="btn-secondary" id="cycleCancelBtn">${t('cycles.cancelForm')}</button>
      <button type="button" class="btn-primary" id="cycleSaveBtn">
        <i data-lucide="save"></i>
        <span>${t('cycles.saveCycle')}</span>
      </button>
    </div>
  `;
  list.prepend(form);
  if (typeof lucide !== 'undefined') lucide.createIcons();

  document.getElementById('cycleCancelBtn').addEventListener('click', () => form.remove());
  document.getElementById('cycleSaveBtn').addEventListener('click', async () => {
    const objective = document.getElementById('cycleObjective').value.trim();
    if (!objective) return;

    const body = {
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

    try {
      const result = await createCycle(body);
      form.remove();
      await loadCycles();
      await checkActiveCycle();
      if (result.cycle) {
        const promptResult = await requestJson(`/api/cycles/${result.cycle.id}/prompt`, null, 'GET');
        if (promptResult.prompt) showPromptModal(promptResult.prompt);
      }
    } catch (err) {
      alert(err.message);
    }
  });
}

async function handleCopyPrompt() {
  const output = document.getElementById('promptOutput');
  try {
    await navigator.clipboard.writeText(output.textContent);
    const btn = document.getElementById('promptCopyBtn');
    const span = btn.querySelector('span');
    span.textContent = t('aiCoach.copied');
    setTimeout(() => { span.textContent = t('cycles.copyPrompt'); }, 2000);
  } catch {
    /* clipboard unavailable */
  }
}

async function handleAction(e) {
  const btn = e.target.closest('[data-id]');
  if (!btn) return;
  const id = btn.dataset.id;

  if (btn.classList.contains('cycle-complete-btn')) {
    await updateCycle(id, { status: 'completed' });
    await loadCycles();
    await checkActiveCycle();
  } else if (btn.classList.contains('cycle-cancel-btn')) {
    await updateCycle(id, { status: 'cancelled' });
    await loadCycles();
    await checkActiveCycle();
  } else if (btn.classList.contains('cycle-prompt-btn')) {
    try {
      const result = await requestJson(`/api/cycles/${id}/prompt`, null, 'GET');
      if (result.prompt) showPromptModal(result.prompt);
    } catch (err) {
      alert(err.message);
    }
  }
}

async function main() {
  const user = await initShell({ active: 'cycles' });
  if (!user) return;

  currentLang = user.preferred_lang || 'en-US';

  await loadCycles();
  await checkActiveCycle();

  document.getElementById('addCycleBtn').addEventListener('click', showAddForm);
  document.getElementById('cycleList').addEventListener('click', handleAction);
  document.getElementById('promptCloseBtn').addEventListener('click', hidePromptModal);
  document.getElementById('promptCopyBtn').addEventListener('click', handleCopyPrompt);
  document.querySelector('.prompt-modal-backdrop')?.addEventListener('click', hidePromptModal);
}

main();
