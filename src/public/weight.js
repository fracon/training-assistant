import {
  initShell,
  getShellI18n,
  getUserPreferences,
  showShellToast,
  showConfirm,
  refreshIcons,
} from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { createDatePicker } from './shared/datepicker.js';
import { formatWeight, weightFromKg, weightToKg, weightUnitLabel } from './shared/units.js';

// Weight log (issue #80). A recurring tool with its own page: the anamnesis
// only asks the weight question and records the first entry. Weights are
// stored in kg and converted only for display through shared/units.js. The
// log never changes the anamnesis answer; it only explains it.

const $ = (id) => document.getElementById(id);
const WEIGHT_RANGE_KG = { min: 20, max: 400 };

let i18n;
let data;
let picker = null;
let editing = null;
// Unit of the number typed in the form, so a body-unit change while it holds
// a value converts it instead of reinterpreting it.
let inputUnit = null;
let busy = false;

function t(key, params) { return translate(i18n.messages, `weightLog.${key}`, params); }
function unit() { return getUserPreferences().body_unit; }
function knownError(code) { return translate(i18n.messages, `weightLog.errors.${code}`) !== `weightLog.errors.${code}`; }

async function api(method, url, body) {
  let response;
  try {
    // A JSON content type without a body is refused by the server.
    response = await fetch(url, body === undefined
      ? { method, headers: { accept: 'application/json' } }
      : { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('network'), { code: 'generic' });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(payload.error || 'request failed'), { code: payload.errors?.[0] || 'generic', field: payload.field });
  return payload;
}

function readNumber(input) {
  if (input.validity?.badInput) return NaN;
  const text = input.value.trim().replace(',', '.');
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

function range() {
  return { min: formatWeight(WEIGHT_RANGE_KG.min, unit(), 0), max: formatWeight(WEIGHT_RANGE_KG.max, unit(), 0) };
}

/* ── Rendering ───────────────────────────────────────────────── */

function renderForm() {
  const current = unit();
  const input = $('weightValue');
  const typed = readNumber(input);
  if (inputUnit && inputUnit !== current && typed !== null && !Number.isNaN(typed))
    input.value = String(Math.round(weightFromKg(weightToKg(typed, inputUnit), current) * 10) / 10);
  inputUnit = current;
  input.min = String(Math.floor(weightFromKg(WEIGHT_RANGE_KG.min, current)));
  input.max = String(Math.ceil(weightFromKg(WEIGHT_RANGE_KG.max, current)));
  input.placeholder = t(`placeholder.${current}`);
  $('weightValueLabel').textContent = t('value', { unit: weightUnitLabel(current) });
  const submit = $('weightSubmit');
  submit.textContent = editing ? t('save') : t('add');
  submit.setAttribute('data-i18n', editing ? 'weightLog.save' : 'weightLog.add');
  $('weightCancel').hidden = !editing;
}

// How the anamnesis answered the weight question, never changed from here.
function renderNote() {
  const { status, weight_status: weightStatus } = data.anamnesis;
  let key = null;
  if (weightStatus === 'declined') key = 'notes.declined';
  else if (weightStatus === 'answered') key = 'notes.answered';
  else if (status !== 'completed') key = 'notes.unanswered';
  $('weightAnamnesisNote').hidden = !key;
  $('weightAnamnesisNoteText').textContent = key ? t(key) : '';
}

function renderList() {
  const list = $('weightList');
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused ? `${focused.dataset.id}:${focused.dataset.action}` : null;
  list.textContent = '';
  $('weightEmpty').hidden = data.weights.length > 0;
  for (const entry of data.weights) {
    const item = document.createElement('li');
    item.className = 'weight-row';
    const date = formatDate(entry.measured_on, i18n.language);
    const text = document.createElement('span');
    text.className = 'weight-row-value';
    const value = document.createElement('strong');
    value.textContent = formatWeight(entry.weight_kg, unit());
    const when = document.createElement('span');
    when.className = 'weight-row-date';
    when.textContent = date;
    text.append(value, when);
    const actions = document.createElement('div');
    actions.className = 'weight-actions';
    for (const [action, icon, key] of [['edit', 'pencil', 'edit'], ['delete', 'trash-2', 'delete']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn-icon${action === 'delete' ? ' weight-danger' : ''}`;
      button.dataset.id = String(entry.id);
      button.dataset.action = action;
      button.setAttribute('aria-label', t(key, { date }));
      button.innerHTML = `<i data-lucide="${icon}"></i>`;
      const tooltip = document.createElement('span');
      tooltip.className = 'custom-tooltip';
      tooltip.setAttribute('aria-hidden', 'true');
      tooltip.textContent = t(key, { date });
      button.appendChild(tooltip);
      button.addEventListener('click', () => (action === 'edit' ? startEdit(entry) : remove(entry, button)));
      actions.appendChild(button);
    }
    item.append(text, actions);
    list.appendChild(item);
  }
  if (focusKey) {
    const [id, action] = focusKey.split(':');
    list.querySelector(`button[data-id="${id}"][data-action="${action}"]`)?.focus();
  }
  refreshIcons();
}

function render() {
  renderForm();
  renderNote();
  renderList();
}

/* ── Form ────────────────────────────────────────────────────── */

function fieldError(id, code, params) {
  const error = $(`${id}Error`);
  error.textContent = translate(i18n.messages, `weightLog.errors.${knownError(code) ? code : 'generic'}`, params);
  error.hidden = false;
  $(id).setAttribute('aria-invalid', 'true');
  $(id).focus();
}

function clearErrors() {
  for (const id of ['weightValue', 'weightDate']) {
    $(`${id}Error`).hidden = true;
    $(`${id}Error`).textContent = '';
    $(id).removeAttribute('aria-invalid');
  }
}

function startEdit(entry) {
  editing = entry.id;
  clearErrors();
  $('weightValue').value = String(Math.round(weightFromKg(entry.weight_kg, unit()) * 10) / 10);
  inputUnit = unit();
  picker?.setValue(entry.measured_on);
  renderForm();
  $('weightValue').focus();
}

function stopEdit({ restore = false } = {}) {
  const id = editing;
  editing = null;
  $('weightValue').value = '';
  picker?.setValue(data.today);
  clearErrors();
  renderForm();
  if (restore && id !== null) $('weightList').querySelector(`button[data-id="${id}"][data-action="edit"]`)?.focus();
}

async function submit(event) {
  event.preventDefault();
  if (busy) return;
  clearErrors();
  const typed = readNumber($('weightValue'));
  if (typed === null || Number.isNaN(typed)) return fieldError('weightValue', 'invalidWeight');
  const kg = weightToKg(typed, unit());
  if (kg < WEIGHT_RANGE_KG.min || kg > WEIGHT_RANGE_KG.max) return fieldError('weightValue', 'weightOutOfRange', range());
  const body = { measured_on: picker?.getValue() || data.today, weight_kg: Math.round(kg * 100) / 100 };
  busy = true;
  $('weightSubmit').disabled = true;
  try {
    const wasEditing = editing !== null;
    if (wasEditing) {
      const saved = await api('PATCH', `/api/body-weights/${editing}`, body);
      data.weights = data.weights.map((entry) => (entry.id === saved.weight.id ? saved.weight : entry));
    } else {
      const saved = await api('POST', '/api/body-weights', body);
      data.weights = [saved.weight, ...data.weights];
    }
    data.weights.sort((a, b) => b.measured_on.localeCompare(a.measured_on) || b.id - a.id);
    renderList();
    stopEdit({ restore: wasEditing });
    showShellToast(i18n.messages, wasEditing ? 'weightLog.toasts.updated' : 'weightLog.toasts.saved');
    if (!wasEditing) $('weightValue').focus();
  } catch (error) {
    fieldError(error.field === 'measured_on' ? 'weightDate' : 'weightValue', error.code, error.code === 'weightOutOfRange' ? range() : undefined);
  } finally {
    busy = false;
    $('weightSubmit').disabled = false;
  }
}

async function remove(entry, trigger) {
  if (busy) return;
  const date = formatDate(entry.measured_on, i18n.language);
  const confirmed = await showConfirm({ title: t('deleteTitle'), message: t('deleteConfirm', { date }), confirmLabel: t('deleteTitle'), cancelLabel: t('cancel') });
  if (!confirmed) { trigger.focus(); return; }
  busy = true;
  try {
    await api('DELETE', `/api/body-weights/${entry.id}`);
    const index = data.weights.findIndex((item) => item.id === entry.id);
    data.weights = data.weights.filter((item) => item.id !== entry.id);
    if (editing === entry.id) stopEdit();
    renderList();
    showShellToast(i18n.messages, 'weightLog.toasts.deleted');
    const next = $('weightList').querySelectorAll('button[data-action="delete"]')[Math.min(index, data.weights.length - 1)];
    (next || $('weightValue')).focus();
  } catch (error) {
    showShellToast(i18n.messages, `weightLog.errors.${knownError(error.code) ? error.code : 'generic'}`, 'error', 5000);
    trigger.focus();
  } finally {
    busy = false;
  }
}

/* ── Load and wiring ─────────────────────────────────────────── */

async function load() {
  $('weightLoading').hidden = false;
  $('weightLoadError').hidden = true;
  try {
    data = await api('GET', '/api/body-weights');
  } catch {
    $('weightLoading').hidden = true;
    $('weightLoadError').hidden = false;
    return;
  }
  $('weightLoading').hidden = true;
  $('weightFormCard').hidden = false;
  $('weightHistory').hidden = false;
  picker?.setValue(data.today);
  render();
}

async function initWeight() {
  const user = await initShell({ active: 'weight' });
  if (!user) return;
  i18n = getShellI18n();
  picker = createDatePicker($('weightDate'), { getLanguage: () => i18n.language, getWeekStart: () => getUserPreferences().first_day_of_week });
  $('weightForm').addEventListener('submit', submit);
  $('weightCancel').addEventListener('click', () => stopEdit({ restore: true }));
  $('weightRetry').addEventListener('click', () => load());
  document.addEventListener('app:languagechange', () => {
    if (!data) return;
    render();
    picker?.refresh();
  });
  document.addEventListener('kinesis:preferences-changed', () => {
    if (data) render();
  });
  await load();
}

if (typeof document !== 'undefined' && document.getElementById('appView')) initWeight();
