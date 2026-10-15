import {
  initShell,
  getShellI18n,
  showConfirm,
  showShellToast,
} from './shared/shell.js';
import { requestJson } from './shared/api.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { createDatePicker } from './shared/datepicker.js';
import { copyPromptText } from './shared/workout-prompts.js';

async function initMemory() {
  const user = await initShell();
  if (!user) return;
  const $ = (id) => document.getElementById(id);
  const i18n = getShellI18n();
  const t = (key) => translate(i18n.messages, `memory.${key}`);
  const fields = ['experience', 'goals', 'preferences', 'restrictions'];
  const picker = createDatePicker($('entryDate'), {
    getLanguage: () => i18n.language,
  });
  const previewPicker =
    user.role === 'admin'
      ? createDatePicker($('previewDate'), { getLanguage: () => i18n.language })
      : null;
  const dirty = new Set();
  for (const field of fields)
    $(field).addEventListener('input', () => dirty.add(field));
  let memory = null;
  let editing = null;
  let editingMissing = false;
  let busy = false;
  let resources = null;
  let loaded = false;
  let errorKey = null;
  const debugLabels = [];
  let refreshResources = () => {};
  if (user.role !== 'admin') $('memoryDebug').remove();
  else $('memoryDebug').hidden = false;
  function controls() {
    $('profileForm').querySelector('[type=submit]').disabled = !loaded || busy;
    $('entryForm').querySelector('[type=submit]').disabled =
      !loaded || busy || editingMissing;
    $('reloadMemory').disabled = busy;
    $('cancelEntry').disabled = busy;
    for (const button of $('memoryEntries').querySelectorAll('button'))
      button.disabled = busy;
    if (user.role === 'admin')
      $('previewForm').querySelector('[type=submit]').disabled =
        !resources || busy;
  }
  function error(error, focus = true) {
    const code = error?.codes?.[0];
    errorKey =
      code && t(`errors.${code}`) !== `memory.errors.${code}`
        ? `errors.${code}`
        : 'errors.generic';
    const message = t(errorKey);
    $('memoryError').textContent = message;
    $('memoryError').classList.remove('hidden');
    if (focus) $('memoryError').focus();
  }
  function clearError() {
    errorKey = null;
    $('memoryError').classList.add('hidden');
    for (const input of document.querySelectorAll('[aria-invalid]')) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }
  function renderEntries() {
    const focused = $('memoryEntries').contains(document.activeElement)
      ? {
          id: document.activeElement.dataset.entryId,
          action: document.activeElement.dataset.action,
        }
      : null;
    $('memoryEntries').replaceChildren();
    if (!memory.entries.length) {
      const p = document.createElement('p');
      p.className = 'field-hint';
      p.textContent = t('empty');
      $('memoryEntries').append(p);
    }
    for (const entry of memory.entries) {
      const card = document.createElement('article');
      card.className = 'shoe-card memory-entry';
      const title = document.createElement('h3');
      title.textContent = `${t(`kinds.${entry.kind}`)} · ${t(`states.${entry.state}`)}`;
      const content = document.createElement('p');
      content.textContent = entry.text;
      const source = document.createElement('p');
      source.className = 'field-hint';
      source.textContent = `${t(`authorities.${entry.authority}`)} · ${formatDate(entry.observed_on, i18n.language)} · ${t('updated')}: ${formatDate(entry.updated_at.slice(0, 10), i18n.language)}`;
      card.append(title, content, source);
      if (['user_report', 'user_action'].includes(entry.authority)) {
        const actions = document.createElement('div');
        actions.className = 'form-actions';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.dataset.entryId = entry.id;
        edit.dataset.action = 'edit';
        edit.className = 'btn-secondary';
        edit.textContent = t('edit');
        edit.addEventListener('click', () => {
          editing = entry;
          editingMissing = false;
          $('entryKind').value = entry.kind;
          $('entryText').value = entry.text;
          picker.setValue(entry.observed_on);
          $('entryState').value = entry.state;
          controls();
          $('entryText').focus();
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.entryId = entry.id;
        remove.dataset.action = 'delete';
        remove.className = 'btn-secondary';
        remove.textContent = t('delete');
        remove.addEventListener('click', async () => {
          if (
            !(await showConfirm({
              title: t('delete'),
              message: t('deleteConfirm'),
              confirmLabel: t('delete'),
              cancelLabel: t('cancel'),
            }))
          )
            return;
          await mutate(async () => {
            await requestJson(
              `/api/ai/memory/${encodeURIComponent(entry.id)}`,
              null,
              'DELETE',
            );
            memory = await requestJson('/api/ai/memory', undefined, 'GET');
            const restoreFocus =
              document.activeElement === remove ||
              document.activeElement === document.body;
            if (editing?.id === entry.id) resetEntry();
            renderEntries();
            if (restoreFocus) $('cancelEntry').focus();
          });
        });
        actions.append(edit, remove);
        card.append(actions);
      }
      $('memoryEntries').append(card);
    }
    if (focused)
      [...$('memoryEntries').querySelectorAll('button')]
        .find(
          (button) =>
            button.dataset.entryId === focused.id &&
            button.dataset.action === focused.action,
        )
        ?.focus();
    const updated = memory.profile.updatedAt;
    $('profileSource').textContent = updated
      ? `${t('authorities.user_report')} · ${t('updated')}: ${formatDate(updated.slice(0, 10), i18n.language)}`
      : t('profileEmpty');
    controls();
  }
  function resetEntry() {
    editing = null;
    editingMissing = false;
    $('entryForm').reset();
    picker.setValue('');
    controls();
  }
  async function mutate(action) {
    if (busy) return;
    busy = true;
    controls();
    clearError();
    try {
      await action();
      showShellToast(i18n.messages, 'memory.saved');
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      controls();
    }
  }
  async function load(initial = false) {
    if (busy) return;
    busy = true;
    controls();
    clearError();
    try {
      const populate = initial || !loaded;
      memory = await requestJson('/api/ai/memory', undefined, 'GET');
      if (editing) {
        const refreshed = memory.entries.find(
          (entry) => entry.id === editing.id,
        );
        editingMissing = !refreshed;
        if (refreshed) editing = refreshed;
        else error({ codes: ['memoryNotFound'] });
      }
      loaded = true;
      if (populate)
        for (const field of fields)
          if (!dirty.has(field))
            $(field).value = memory.profile.fields[field]?.value || '';
      renderEntries();
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      controls();
    }
  }
  $('reloadMemory').addEventListener('click', () => load(false));
  $('profileForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!loaded) return;
    mutate(async () => {
      memory = await requestJson(
        '/api/ai/profile',
        {
          fields: Object.fromEntries(fields.map((key) => [key, $(key).value])),
          expected_version: memory.profile.version,
        },
        'PUT',
      );
      renderEntries();
    });
  });
  $('entryForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!loaded) return;
    if (!$('entryText').value.trim() || !picker.getValue()) {
      clearError();
      const input = !$('entryText').value.trim()
        ? $('entryText')
        : $('entryDate');
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'memoryError');
      errorKey = 'errors.required';
      $('memoryError').textContent = t(errorKey);
      $('memoryError').classList.remove('hidden');
      input.focus();
      return;
    }
    mutate(async () => {
      const snapshot = JSON.stringify({
        kind: $('entryKind').value,
        text: $('entryText').value,
        date: picker.getValue(),
        state: $('entryState').value,
      });
      memory = await requestJson(
        editing
          ? `/api/ai/memory/${encodeURIComponent(editing.id)}`
          : '/api/ai/memory',
        {
          kind: $('entryKind').value,
          text: $('entryText').value,
          observed_on: picker.getValue(),
          state: $('entryState').value,
          expected_version: editing?.version || 0,
        },
        editing ? 'PUT' : 'POST',
      );
      const unchanged =
        snapshot ===
        JSON.stringify({
          kind: $('entryKind').value,
          text: $('entryText').value,
          date: picker.getValue(),
          state: $('entryState').value,
        });
      const focusBelongsToForm =
        $('entryForm').contains(document.activeElement) ||
        document.activeElement === document.body;
      if (unchanged) resetEntry();
      renderEntries();
      if (unchanged && focusBelongsToForm) $('entryText').focus();
    });
  });
  $('cancelEntry').addEventListener('click', () => {
    resetEntry();
    clearError();
    $('entryText').focus();
  });
  if (user.role === 'admin') {
    function renderResources() {
      const purpose = $('previewPurpose').value;
      const selected = $('previewResource').value;
      $('previewResource').replaceChildren();
      for (const row of purpose === 'analysis'
        ? resources.trainings
        : resources.cycles) {
        const option = document.createElement('option');
        option.value = row.id;
        option.textContent =
          purpose === 'analysis'
            ? `${formatDate(row.dia, i18n.language)} · ${row.treino || row.tipo}`
            : row.objective;
        $('previewResource').append(option);
      }
      if (
        [...$('previewResource').options].some(
          (option) => option.value === selected,
        )
      )
        $('previewResource').value = selected;
      $('previewResource').disabled = purpose === 'workouts';
      $('previewDate').closest('.field').hidden = purpose !== 'workouts';
    }
    refreshResources = () => {
      if (resources) renderResources();
    };
    $('previewPurpose').addEventListener('change', () => {
      if (resources) renderResources();
    });
    $('previewForm').addEventListener('submit', (event) => {
      event.preventDefault();
      mutate(async () => {
        const purpose = $('previewPurpose').value;
        const result = await requestJson('/api/ai/admin/preview', {
          purpose,
          ...(purpose === 'workouts'
            ? { target_date: previewPicker.getValue() }
            : { resource_id: $('previewResource').value }),
        });
        $('promptPreview').value = result.prompt;
        $('contextPreview').value = JSON.stringify(result.context, null, 2);
        $('copyPrompt').disabled = false;
      });
    });
    $('copyPrompt').addEventListener('click', async () => {
      if (await copyPromptText($('promptPreview').value))
        showShellToast(i18n.messages, 'memory.copied');
      else error(new Error());
    });
    try {
      const [cycles, trainings, usage, executions] = await Promise.all([
        requestJson('/api/cycles', undefined, 'GET'),
        requestJson('/api/calendar/trainings', undefined, 'GET'),
        requestJson('/api/ai/admin/usage', undefined, 'GET'),
        requestJson('/api/ai/executions', undefined, 'GET'),
      ]);
      resources = { cycles: cycles.cycles, trainings: trainings.trainings };
      renderResources();
      const usageLabel = () => {
        $('usageSummary').textContent =
          `${t('usage')}: ${usage.usage.reduce((sum, row) => sum + row.tokens, 0)} ${t('tokens')}`;
      };
      debugLabels.push(usageLabel);
      usageLabel();
      for (const execution of executions.executions) {
        const button = document.createElement('button');
        button.className = 'btn-secondary';
        button.type = 'button';
        const label = () => {
          button.textContent = `${t(`purposes.${execution.purpose}`)} · ${formatDate(execution.created_at.slice(0, 10), i18n.language)} · ${t(`executionStates.${execution.state}`)}`;
        };
        debugLabels.push(label);
        label();
        button.addEventListener('click', async () => {
          try {
            const result = await requestJson(
              `/api/ai/admin/executions/${encodeURIComponent(execution.id)}`,
              undefined,
              'GET',
            );
            $('contextPreview').value = JSON.stringify(result, null, 2);
          } catch (e) {
            error(e);
          }
        });
        $('executionList').append(button);
      }
    } catch (e) {
      error(e);
    }
    controls();
  }
  document.addEventListener('app:languagechange', () => {
    picker.refresh();
    previewPicker?.refresh();
    if (memory) renderEntries();
    if (errorKey) $('memoryError').textContent = t(errorKey);
    refreshResources();
    debugLabels.forEach((update) => update());
  });
  await load(true);
}
if (typeof document !== 'undefined') initMemory();
