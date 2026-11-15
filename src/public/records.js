import { initShell, getShellI18n, getUserPreferences, showConfirm, showShellToast } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { createDatePicker } from './shared/datepicker.js';
import { requestJson } from './shared/api.js';

const $ = (id) => document.getElementById(id);
let i18n, data, picker, opener;
let busy = false;
let currentError = null;
const t = (key, params) => translate(i18n.messages, `records.${key}`, params);
const time = (seconds) => `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function action(text, callback) {
  const button = element('button', text, 'btn-secondary');
  button.type = 'button';
  button.disabled = busy;
  button.addEventListener('click', () => callback(button));
  return button;
}
function render() {
  const focus = document.activeElement;
  const key = focus?.dataset.focusKey;
  $('recordsList').textContent = '';
  for (const record of data.records) {
    const card = element('section', '', 'shoe-card weight-card');
    const name = t(`distances.${record.distance}`);
    card.append(element('h2', name));
    const best = record.best;
    if (best) {
      card.append(element('p', time(best.time_seconds), 'record-value'));
      const date = best.achieved_on ? formatDate(best.achieved_on, i18n.language) : best.year ? t('year', { year: best.year }) : t('unknownDate');
      card.append(element('p', `${t(`origin.${best.origin}`)} · ${date}`, 'record-source'));
      if (best.race_name) card.append(element('p', best.race_name));
      if (best.training_id) {
        const link = element('a', t('openSession'));
        link.href = `/training-result.html?id=${best.training_id}`;
        card.append(link);
      }
    }
    if (record.manual && best?.origin !== 'manual') card.append(element('p', t('manualTime', { time: time(record.manual.time_seconds) }), 'record-source'));
    const actions = element('div', '', 'record-actions');
    const edit = action(t(best ? 'edit' : 'add'), (button) => editRecord(record, button));
    edit.setAttribute('aria-label', `${edit.textContent} · ${name}`);
    edit.dataset.focusKey = `${record.distance}-edit`;
    actions.append(edit);
    if (record.manual) {
      const remove = action(t('remove'), (button) => removeRecord(record, button));
      remove.setAttribute('aria-label', `${remove.textContent} · ${name}`);
      remove.dataset.focusKey = `${record.distance}-remove`;
      actions.append(remove);
    }
    card.append(actions);
    $('recordsList').append(card);
  }
  if (key && !focus.isConnected) $('recordsList').querySelector(`[data-focus-key="${key}"]`)?.focus();
  const selected = $('recordDistance').value;
  $('recordDistance').textContent = '';
  for (const record of data.records) {
    const option = element('option', t(`distances.${record.distance}`));
    option.value = record.distance;
    $('recordDistance').append(option);
  }
  if (selected) $('recordDistance').value = selected;
  if (currentError) $('recordError').textContent = t(`errors.${currentError}`);
}
function clearError() {
  currentError = null;
  $('recordError').hidden = true;
  document.querySelectorAll('#recordForm [aria-invalid]').forEach((node) => node.removeAttribute('aria-invalid'));
}
function error(code, { focus = true } = {}) {
  const known = Object.hasOwn(i18n.messages.records.errors, code) ? code : 'generic';
  currentError = known;
  $('recordError').textContent = t(`errors.${known}`);
  $('recordError').hidden = false;
  const id = code === 'invalidDate' ? 'recordDate' : code === 'invalidRaceName' ? 'recordRace' : 'recordHours';
  $(id).setAttribute('aria-invalid', 'true');
  if (focus) $(id).focus();
}
function editRecord(record, button) {
  if (busy) return;
  opener = button.dataset.focusKey;
  clearError();
  $('recordFormCard').hidden = false;
  $('recordDistance').value = record.distance;
  const current = record.best;
  const seconds = current?.time_seconds;
  ['Hours', 'Minutes', 'Seconds'].forEach((part, index) => {
    $(`record${part}`).value = seconds === undefined ? '' : [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60][index];
  });
  picker.setValue(current?.achieved_on || '');
  $('recordRace').value = current?.race_name || '';
  $('recordHours').focus();
}
function closeForm({ restore = true } = {}) {
  $('recordFormCard').hidden = true;
  clearError();
  if (restore) ($('recordsList').querySelector(`[data-focus-key="${opener}"]`) || $('recordsTitle')).focus();
}
function lock(value) {
  busy = value;
  document.querySelectorAll('#recordForm input, #recordForm select, #recordForm button, #recordsList button').forEach((node) => { node.disabled = value; });
}
async function submit(event) {
  event.preventDefault();
  if (busy) return;
  clearError();
  const parts = ['Hours', 'Minutes', 'Seconds'].map((part) => $(`record${part}`));
  const values = parts.map((input) => input.value === '' ? 0 : Number(input.value));
  const seconds = values[0] * 3600 + values[1] * 60 + values[2];
  if (parts.some((input) => input.validity.badInput) || values.some((value) => !Number.isInteger(value) || value < 0) || values[1] > 59 || values[2] > 59 || seconds <= 0 || seconds > 604800) return error('invalidTime');
  lock(true);
  try {
    data = await requestJson(`/api/records/${$('recordDistance').value}`, { time_seconds: seconds, achieved_on: picker.getValue() || null, race_name: $('recordRace').value || null }, 'PUT');
    lock(false);
    render();
    closeForm({ restore: document.activeElement === document.body || $('recordForm').contains(document.activeElement) });
    showShellToast(i18n.messages, 'records.saved');
  } catch (err) { lock(false); error(err.codes?.[0], { focus: document.activeElement === document.body || $('recordForm').contains(document.activeElement) }); }
  finally { lock(false); }
}
async function removeRecord(record, button) {
  if (busy) return;
  const focusKey = button.dataset.focusKey;
  if (!await showConfirm({ title: t('remove'), message: t('removeConfirm', { distance: t(`distances.${record.distance}`) }), confirmLabel: t('remove'), cancelLabel: t('cancel') })) return;
  lock(true);
  try {
    data = await requestJson(`/api/records/${record.distance}`, {}, 'DELETE');
    lock(false);
    render();
    // Restore only if focus remained on the action being removed.
    if (!document.activeElement || document.activeElement === document.body || document.activeElement.dataset.focusKey === focusKey)
      $('recordsList').querySelector(`[data-focus-key="${record.distance}-edit"]`)?.focus();
    showShellToast(i18n.messages, 'records.deleted');
  } catch {
    lock(false);
    showShellToast(i18n.messages, 'records.errors.generic', 'error');
    if (document.activeElement === document.body) $('recordsList').querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
  }
  finally { lock(false); }
}
async function load() {
  $('recordsLoading').hidden = false;
  $('recordsLoadError').hidden = true;
  try { data = await requestJson('/api/records', undefined, 'GET'); render(); }
  catch { $('recordsLoadError').hidden = false; }
  finally { $('recordsLoading').hidden = true; }
}
async function init() {
  if (!await initShell({ active: 'records' })) return;
  i18n = getShellI18n();
  picker = createDatePicker($('recordDate'), { getLanguage: () => i18n.language, getWeekStart: () => getUserPreferences().first_day_of_week });
  $('recordForm').addEventListener('submit', submit);
  $('recordCancel').addEventListener('click', () => { if (!busy) closeForm(); });
  $('recordDistance').addEventListener('change', () => {
    const record = data.records.find((row) => row.distance === $('recordDistance').value);
    editRecord(record, $('recordsList').querySelector(`[data-focus-key="${record.distance}-edit"]`));
  });
  $('recordsRetry').addEventListener('click', load);
  document.addEventListener('app:languagechange', () => { if (data) render(); picker.refresh(); });
  await load();
}
init();
