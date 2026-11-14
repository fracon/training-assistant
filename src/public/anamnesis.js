import {
  initShell,
  getShellI18n,
  getUserPreferences,
  showShellToast,
  showConfirm,
  openPreferencesModal,
  refreshIcons,
} from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { createDatePicker } from './shared/datepicker.js';
import {
  convertDistanceFromKm,
  convertDistanceToKm,
  formatDistance,
  formatHeight,
  formatWeight,
  heightFromCm,
  heightToCm,
  weightFromKg,
  weightToKg,
  weightUnitLabel,
} from './shared/units.js';

// Athlete anamnesis (issue #80). The questionnaire definition comes from
// `GET /api/anamnesis`; the backend validates every answer again. Nothing on
// this page calls AI. Static copy uses data-i18n; text with values is
// registered in `bindings` and recomputed on a language change, so typed but
// unsaved answers are never lost when the language switches.

const $ = (id) => document.getElementById(id);
const WEIGHT_RANGE_KG = { min: 20, max: 400 };
const RACE_KEYS = ['5k', '10k', '21k', '42k', 'other'];

let i18n;
let data;
let stepIndex = 0;
let mode = 'wizard'; // 'wizard' | 'edit' (one step from the summary) | 'review'
let fields = [];
let bindings = [];
let weightPicker = null;
let stepDatePicker = null;
let editingWeight = null;
let busy = false;

function t(key, params) { return translate(i18n.messages, `anamnesis.${key}`, params); }
function prefs() { return getUserPreferences(); }
function questionSteps() { return data.questionnaire.steps; }
function totalSteps() { return questionSteps().length + 1; }

function bind(element, render) {
  bindings.push(() => { element.textContent = render(); });
  element.textContent = render();
  return element;
}

function el(tag, className, attributes = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

async function api(method, url, body) {
  let response;
  try {
    // A JSON content type without a body is refused by the server, so bodiless
    // requests (GET, DELETE) send only the Accept header.
    response = await fetch(url, body === undefined
      ? { method, headers: { accept: 'application/json' } }
      : { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('network'), { code: 'generic' });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(payload.error || 'request failed'), {
      status: response.status,
      code: payload.errors?.[0] || 'generic',
      field: payload.field,
      missing: payload.missing,
    });
  return payload;
}

function knownError(code) {
  return translate(i18n.messages, `anamnesis.errors.${code}`) !== `anamnesis.errors.${code}`;
}

/* ── Answer formatting (review and summary) ─────────────────── */

function formatAnswer(item, answer) {
  if (!answer) return t('answers.notAnswered');
  if (answer.status === 'unknown') return t('answers.unknown');
  if (answer.status === 'declined') return t('answers.declined');
  if (answer.status === 'not_applicable') return t('answers.notApplicable');
  const value = answer.value;
  switch (item.type) {
    case 'height': return formatHeight(value, prefs().body_unit);
    case 'distance': return formatDistance(value, prefs().distance_unit, 1);
    case 'weight': {
      const latest = data.weights[0];
      return latest ? t('weight.latest', { weight: formatWeight(latest.weight_kg, prefs().body_unit), date: formatDate(latest.measured_on, i18n.language) }) : t('answers.notAnswered');
    }
    case 'choice': return t(`items.${item.key}.options.${value}`);
    case 'multi': return value.options.map((option) => (option === 'other' && value.other_text ? `${t(`items.${item.key}.options.other`)}: ${value.other_text}` : t(`items.${item.key}.options.${option}`))).join(', ');
    case 'yes_no': return value.answer === 'yes' ? (value.details ? `${t('answers.yes')}: ${value.details}` : t('answers.yes')) : t('answers.no');
    case 'races': return value.length ? value.map(formatRace).join('; ') : t('answers.none');
    default: return String(value);
  }
}

function formatRace(race) {
  const distance = race.distance === 'other' ? formatDistance(race.distance_km, prefs().distance_unit, 1) : t(`races.distances.${race.distance}`);
  return `${distance} · ${formatSeconds(race.time_seconds)} · ${race.year}`;
}

function formatSeconds(total) {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function parseTime(text) {
  const match = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)$/.exec(String(text).trim());
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseNumber(text) {
  const normalized = String(text ?? '').trim().replace(',', '.');
  if (normalized === '') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : NaN;
}

/* ── Field builders ──────────────────────────────────────────── */

// Each builder returns { key, element, collect, showError, clearError, focus }.
// collect() → { answer } | { missing: true } | { error: code, params }.
function baseField(item, { group = false } = {}) {
  const wrapper = el(group ? 'fieldset' : 'div', 'field anamnesis-item');
  wrapper.dataset.key = item.key;
  const label = el(group ? 'legend' : 'label', 'field-label');
  label.id = `q-${item.key}-label`;
  wrapper.appendChild(label);
  const hintKey = `items.${item.key}.hint`;
  let hint = null;
  if (t(hintKey) !== `anamnesis.${hintKey}`) {
    hint = el('p', 'field-hint', { id: `q-${item.key}-hint` });
    bind(hint, () => t(hintKey));
    wrapper.appendChild(hint);
  }
  const error = el('p', 'field-error', { id: `q-${item.key}-error` });
  error.hidden = true;
  const controls = [];
  const describe = (control) => {
    control.setAttribute('aria-describedby', [hint?.id, error.id].filter(Boolean).join(' '));
    controls.push(control);
  };
  let errorRender = null;
  const field = {
    key: item.key,
    item,
    element: wrapper,
    label,
    controls,
    describe,
    showError(code, params) {
      errorRender = () => t(`errors.${knownError(code) ? code : 'invalidAnswer'}`, params);
      error.textContent = errorRender();
      error.hidden = false;
      for (const control of controls) control.setAttribute('aria-invalid', 'true');
    },
    clearError() {
      errorRender = null;
      error.hidden = true;
      error.textContent = '';
      for (const control of controls) control.removeAttribute('aria-invalid');
    },
    focus() { controls.find((control) => !control.disabled)?.focus(); },
    finish() { wrapper.appendChild(error); bindings.push(() => { if (errorRender) error.textContent = errorRender(); }); },
  };
  return field;
}

function choiceChip(type, name, value, checked) {
  const chip = el('label', 'preference-choice');
  const input = el('input', '', { type, name, value });
  input.checked = checked;
  const text = el('span');
  chip.append(input, text);
  return { chip, input, text };
}

// "I don't know" / "I'd rather not say" alternatives for value questions.
// Checking one disables the value inputs; they are mutually exclusive.
function statusAlternatives(field, item, answer, valueInputs) {
  const alternatives = item.statuses.filter((status) => status !== 'answered');
  if (!alternatives.length) return () => null;
  const options = el('div', 'preference-options anamnesis-alternatives');
  const boxes = alternatives.map((status) => {
    const { chip, input, text } = choiceChip('checkbox', `q-${item.key}-status`, status, answer?.status === status);
    bind(text, () => t(`answers.${status}`));
    field.describe(input);
    options.appendChild(chip);
    return input;
  });
  const sync = () => {
    const chosen = boxes.some((box) => box.checked);
    for (const input of valueInputs) input.disabled = chosen;
  };
  for (const box of boxes) {
    box.addEventListener('change', () => {
      if (box.checked) for (const other of boxes) if (other !== box) other.checked = false;
      sync();
    });
  }
  sync();
  field.element.appendChild(options);
  return () => boxes.find((box) => box.checked)?.value ?? null;
}

function numberInput(id, value, inputmode = 'decimal') {
  const input = el('input', '', { id, type: 'text', inputmode, autocomplete: 'off' });
  if (value !== null && value !== undefined) input.value = String(value);
  return input;
}

function valueField(item, answer) {
  const field = baseField(item);
  const unit = item.type === 'distance' ? prefs().distance_unit : null;
  bind(field.label, () => t(`items.${item.key}.label`, { unit }));
  let inputs;
  if (item.type === 'height' && prefs().body_unit === 'imperial') {
    const current = answer?.status === 'answered' ? heightFromCm(answer.value, 'imperial') : null;
    const feet = numberInput(`q-${item.key}`, current?.feet, 'numeric');
    const inches = numberInput(`q-${item.key}-inches`, current?.inches);
    const row = el('div', 'anamnesis-inline');
    for (const [input, key] of [[feet, 'height.feet'], [inches, 'height.inches']]) {
      const part = el('div', 'field');
      const partLabel = el('label', 'field-hint', { for: input.id });
      bind(partLabel, () => t(key));
      part.append(partLabel, input);
      row.appendChild(part);
    }
    field.label.setAttribute('for', feet.id);
    field.element.appendChild(row);
    inputs = [feet, inches];
  } else {
    let shown = null;
    if (answer?.status === 'answered') {
      if (item.type === 'distance') shown = Math.round(convertDistanceFromKm(answer.value, unit) * 10) / 10;
      else shown = answer.value;
    }
    const input = numberInput(`q-${item.key}`, shown, item.type === 'integer' ? 'numeric' : 'decimal');
    if (item.type === 'height') bind(field.label, () => t('height.cm'));
    field.label.setAttribute('for', input.id);
    field.element.appendChild(input);
    inputs = [input];
  }
  inputs.forEach(field.describe);
  const alternative = statusAlternatives(field, item, answer, inputs);
  field.inputs = inputs;
  field.collect = () => {
    const status = alternative();
    if (status) return { answer: { status } };
    if (inputs.every((input) => input.value.trim() === '')) return { missing: true };
    let value;
    if (item.type === 'height') {
      value = heightToCm(prefs().body_unit === 'imperial'
        ? { feet: inputs[0].value.replace(',', '.'), inches: inputs[1].value.replace(',', '.') }
        : { cm: inputs[0].value.replace(',', '.') }, prefs().body_unit);
      if (value === null) return { error: 'invalidAnswer' };
    } else {
      value = parseNumber(inputs[0].value);
      if (Number.isNaN(value)) return { error: 'invalidAnswer' };
      if (item.type === 'distance') value = convertDistanceToKm(value, unit);
      if (item.type === 'integer' && !Number.isInteger(value)) return { error: 'invalidAnswer' };
    }
    if (value < item.min - 1e-9 || value > item.max + 1e-9) return { error: 'outOfRange', params: rangeParams(item) };
    return { answer: { status: 'answered', value: item.type === 'distance' ? Math.round(value * 100) / 100 : value } };
  };
  field.finish();
  return field;
}

function rangeParams(item) {
  if (item.type === 'distance') {
    const unit = prefs().distance_unit;
    return { min: Math.round(convertDistanceFromKm(item.min, unit)), max: Math.round(convertDistanceFromKm(item.max, unit)) };
  }
  if (item.type === 'height') return { min: formatHeight(item.min, prefs().body_unit), max: formatHeight(item.max, prefs().body_unit) };
  return { min: item.min, max: item.max };
}

function weightField(item, answer) {
  const field = baseField(item);
  bind(field.label, () => t('items.weight.label'));
  const latest = data.weights[0];
  if (latest) {
    const current = el('p', 'anamnesis-latest');
    bind(current, () => t('weight.latest', { weight: formatWeight(latest.weight_kg, prefs().body_unit), date: formatDate(latest.measured_on, i18n.language) }));
    field.element.appendChild(current);
  }
  const row = el('div', 'anamnesis-inline');
  const valuePart = el('div', 'field');
  const valueInput = numberInput('q-weight');
  const valueLabel = el('label', latest ? 'field-hint' : 'field-hint', { for: valueInput.id });
  bind(valueLabel, () => (latest ? t('weight.newEntry') : t('weight.value', { unit: weightUnitLabel(prefs().body_unit) })));
  valuePart.append(valueLabel, valueInput);
  const datePart = el('div', 'field');
  const dateInput = el('input', '', { id: 'q-weight-date', type: 'text', autocomplete: 'off' });
  const dateLabel = el('label', 'field-hint', { for: dateInput.id });
  bind(dateLabel, () => t('weight.date'));
  datePart.append(dateLabel, dateInput);
  row.append(valuePart, datePart);
  field.label.setAttribute('for', valueInput.id);
  field.element.appendChild(row);
  field.describe(valueInput);
  field.describe(dateInput);
  stepDatePicker = createDatePicker(dateInput, { getLanguage: () => i18n.language, getWeekStart: () => prefs().first_day_of_week });
  stepDatePicker?.setValue(data.today);
  const alternative = statusAlternatives(field, item, answer, [valueInput, dateInput]);
  field.collect = () => {
    if (alternative()) return { answer: { status: 'declined' } };
    const typed = parseNumber(valueInput.value);
    if (typed === null) return latest ? { answer: { status: 'answered' } } : { missing: true };
    const kg = Number.isNaN(typed) ? null : weightToKg(typed, prefs().body_unit);
    if (kg === null) return { error: 'invalidWeight' };
    if (kg < WEIGHT_RANGE_KG.min || kg > WEIGHT_RANGE_KG.max) return { error: 'weightOutOfRange', params: weightRange() };
    return { answer: { status: 'answered' }, weight: { measured_on: stepDatePicker?.getValue() || data.today, weight_kg: Math.round(kg * 100) / 100 } };
  };
  field.finish();
  return field;
}

function weightRange() {
  return { min: formatWeight(WEIGHT_RANGE_KG.min, prefs().body_unit, 0), max: formatWeight(WEIGHT_RANGE_KG.max, prefs().body_unit, 0) };
}

function radioGroupField(item, answer, values, labelFor) {
  const field = baseField(item, { group: true });
  bind(field.label, () => t(`items.${item.key}.label`));
  const options = el('div', 'preference-options');
  const current = answer?.status === 'answered' ? (item.type === 'yes_no' ? answer.value.answer : answer.value) : answer ? `status:${answer.status}` : null;
  const radios = values.map((value) => {
    const { chip, input, text } = choiceChip('radio', `q-${item.key}`, value, current === value);
    bind(text, () => labelFor(value));
    field.describe(input);
    options.appendChild(chip);
    return input;
  });
  field.element.appendChild(options);
  field.selected = () => radios.find((radio) => radio.checked)?.value ?? null;
  field.radios = radios;
  return field;
}

function alternativeValues(item) {
  return item.statuses.filter((status) => status !== 'answered').map((status) => `status:${status}`);
}

function choiceField(item, answer) {
  const values = [...item.options, ...alternativeValues(item)];
  const field = radioGroupField(item, answer, values, (value) => (value.startsWith('status:') ? t(`answers.${value.slice(7)}`) : t(`items.${item.key}.options.${value}`)));
  field.collect = () => {
    const value = field.selected();
    if (!value) return { missing: true };
    return { answer: value.startsWith('status:') ? { status: value.slice(7) } : { status: 'answered', value } };
  };
  field.finish();
  return field;
}

function yesNoField(item, answer) {
  const values = ['yes', 'no', ...alternativeValues(item)];
  const field = radioGroupField(item, answer, values, (value) => (value.startsWith('status:') ? t(`answers.${value.slice(7)}`) : t(`answers.${value}`)));
  const details = el('div', 'field anamnesis-details');
  const textarea = el('textarea', 'prompt-textarea', { id: `q-${item.key}-details`, rows: '3', maxlength: '500' });
  textarea.value = answer?.status === 'answered' ? answer.value.details ?? '' : '';
  const detailsLabel = el('label', 'field-hint', { for: textarea.id });
  bind(detailsLabel, () => t(`items.${item.key}.detailsLabel`));
  details.append(detailsLabel, textarea);
  field.element.appendChild(details);
  const sync = () => { details.hidden = field.selected() !== 'yes'; };
  field.radios.forEach((radio) => radio.addEventListener('change', sync));
  sync();
  field.collect = () => {
    const value = field.selected();
    if (!value) return { missing: true };
    if (value.startsWith('status:')) return { answer: { status: value.slice(7) } };
    if (value === 'no') return { answer: { status: 'answered', value: { answer: 'no' } } };
    const text = textarea.value.trim();
    return { answer: { status: 'answered', value: text ? { answer: 'yes', details: text } : { answer: 'yes' } } };
  };
  field.finish();
  return field;
}

function multiField(item, answer) {
  const field = baseField(item, { group: true });
  bind(field.label, () => t(`items.${item.key}.label`));
  const options = el('div', 'preference-options');
  const chosen = answer?.status === 'answered' ? answer.value.options : [];
  const boxes = item.options.map((option) => {
    const { chip, input, text } = choiceChip('checkbox', `q-${item.key}`, option, chosen.includes(option));
    bind(text, () => t(`items.${item.key}.options.${option}`));
    field.describe(input);
    options.appendChild(chip);
    return input;
  });
  field.element.appendChild(options);
  const other = el('div', 'field anamnesis-details');
  const otherInput = el('input', '', { id: `q-${item.key}-other`, type: 'text', maxlength: '120', autocomplete: 'off' });
  otherInput.value = answer?.status === 'answered' ? answer.value.other_text ?? '' : '';
  const otherLabel = el('label', 'field-hint', { for: otherInput.id });
  bind(otherLabel, () => t(`items.${item.key}.otherText`));
  other.append(otherLabel, otherInput);
  field.element.appendChild(other);
  const otherBox = boxes.find((box) => box.value === 'other');
  const sync = () => { other.hidden = !otherBox.checked; };
  otherBox.addEventListener('change', sync);
  sync();
  field.collect = () => {
    const selected = boxes.filter((box) => box.checked).map((box) => box.value);
    if (!selected.length) return { missing: true };
    const text = otherBox.checked ? otherInput.value.trim() : '';
    return { answer: { status: 'answered', value: text ? { options: selected, other_text: text } : { options: selected } } };
  };
  field.finish();
  return field;
}

function racesField(item, answer) {
  const field = baseField(item, { group: true });
  bind(field.label, () => t(`items.${item.key}.label`));
  const list = el('div', 'anamnesis-races');
  const add = el('button', 'btn-secondary', { type: 'button' });
  bind(add, () => t('races.add'));
  const { chip: noneChip, input: none, text: noneText } = choiceChip('checkbox', 'q-race_results-none', 'none', answer?.status === 'answered' && answer.value.length === 0);
  bind(noneText, () => t('races.none'));
  const noneRow = el('div', 'preference-options anamnesis-alternatives');
  noneRow.appendChild(noneChip);
  field.describe(none);
  const rows = [];
  const sync = () => {
    add.disabled = rows.length >= item.max;
    none.disabled = rows.length > 0;
    if (rows.length) none.checked = false;
    rows.forEach((row, index) => { row.number = index + 1; row.renderTitle(); });
  };
  const addRow = (race = null) => {
    const row = el('div', 'anamnesis-race');
    const title = el('p', 'anamnesis-race-title');
    const index = rows.length + 1;
    const select = el('select', '', { id: `q-race-${index}-distance` });
    const options = RACE_KEYS.map((key) => {
      const option = el('option', '', { value: key });
      bind(option, () => (key === 'other' ? t('races.otherDistance') : t(`races.distances.${key}`)));
      select.appendChild(option);
      return option;
    });
    void options;
    select.value = race?.distance ?? '5k';
    const otherKm = numberInput(`q-race-${index}-km`, race?.distance === 'other' ? Math.round(convertDistanceFromKm(race.distance_km, prefs().distance_unit) * 100) / 100 : null);
    const time = el('input', '', { id: `q-race-${index}-time`, type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '0:52:30' });
    if (race) time.value = formatSeconds(race.time_seconds);
    const year = numberInput(`q-race-${index}-year`, race?.year, 'numeric');
    const part = (input, labelKey, params) => {
      const wrapper = el('div', 'field');
      const label = el('label', 'field-hint', { for: input.id });
      bind(label, () => t(labelKey, params?.()));
      wrapper.append(label, input);
      return wrapper;
    };
    const otherPart = part(otherKm, 'races.otherKm', () => ({ unit: prefs().distance_unit }));
    const remove = el('button', 'btn-secondary anamnesis-race-remove', { type: 'button' });
    bind(remove, () => t('races.remove'));
    const grid = el('div', 'anamnesis-race-grid');
    grid.append(part(select, 'races.distance'), otherPart, part(time, 'races.time'), part(year, 'races.year'));
    row.append(title, grid, remove);
    const syncOther = () => { otherPart.hidden = select.value !== 'other'; };
    select.addEventListener('change', syncOther);
    syncOther();
    const entry = {
      element: row,
      number: index,
      renderTitle() { title.textContent = t('races.row', { n: entry.number }); },
      collect() {
        const seconds = parseTime(time.value);
        const yearValue = parseNumber(year.value);
        if (!time.value.trim() || yearValue === null) return { error: 'raceIncomplete' };
        if (seconds === null) return { error: 'timeFormat' };
        if (!Number.isInteger(yearValue)) return { error: 'invalidAnswer' };
        const race = { distance: select.value, time_seconds: seconds, year: yearValue };
        if (select.value === 'other') {
          const km = parseNumber(otherKm.value);
          if (km === null) return { error: 'raceIncomplete' };
          if (Number.isNaN(km)) return { error: 'invalidAnswer' };
          race.distance_km = Math.round(convertDistanceToKm(km, prefs().distance_unit) * 1000) / 1000;
        }
        return { race };
      },
      focus() { select.focus(); },
    };
    bindings.push(() => entry.renderTitle());
    [select, otherKm, time, year].forEach(field.describe);
    remove.addEventListener('click', () => {
      rows.splice(rows.indexOf(entry), 1);
      row.remove();
      sync();
      (rows.at(-1)?.element.querySelector('select') || add).focus();
    });
    rows.push(entry);
    list.appendChild(row);
    sync();
    return entry;
  };
  if (answer?.status === 'answered') answer.value.forEach((race) => addRow(race));
  add.addEventListener('click', () => addRow().focus());
  field.element.append(list, add, noneRow);
  sync();
  field.collect = () => {
    if (!rows.length) return none.checked ? { answer: { status: 'answered', value: [] } } : { missing: true };
    const races = [];
    for (const row of rows) {
      const result = row.collect();
      if (result.error) return result;
      races.push(result.race);
    }
    return { answer: { status: 'answered', value: races } };
  };
  field.finish();
  return field;
}

function buildField(item, answer) {
  if (item.type === 'weight') return weightField(item, answer);
  if (item.type === 'choice') return choiceField(item, answer);
  if (item.type === 'yes_no') return yesNoField(item, answer);
  if (item.type === 'multi') return multiField(item, answer);
  if (item.type === 'races') return racesField(item, answer);
  return valueField(item, answer);
}

/* ── Steps ───────────────────────────────────────────────────── */

function firstIncompleteStep() {
  const missing = new Set(data.anamnesis.missing);
  const index = questionSteps().findIndex((step) => step.items.some((item) => missing.has(item.key)));
  return index;
}

function renderStepList(current) {
  const list = $('anamnesisSteps');
  list.textContent = '';
  const ids = [...questionSteps().map((step) => step.id), 'review'];
  ids.forEach((id, index) => {
    const item = el('li', index === current ? 'is-current' : index < current ? 'is-done' : '');
    if (index === current) item.setAttribute('aria-current', 'step');
    item.setAttribute('data-i18n', `anamnesis.steps.${id}.title`);
    item.textContent = t(`steps.${id}.title`);
    list.appendChild(item);
  });
}

function syncDependents() {
  const runs = fields.find((field) => field.key === 'runs_per_week');
  if (!runs) return;
  const value = parseNumber(runs.inputs[0].value);
  const notApplicable = value === 0 && !runs.inputs[0].disabled;
  for (const field of fields) {
    if (field.item.dependsOn !== 'runs_per_week') continue;
    field.element.hidden = notApplicable;
    field.hiddenAsNotApplicable = notApplicable;
  }
}

function renderStep(index, { focus = true } = {}) {
  bindings = [];
  stepIndex = index;
  const step = questionSteps()[index];
  $('anamnesisWizard').hidden = false;
  $('anamnesisReview').hidden = true;
  renderStepList(index);
  bind($('anamnesisProgress'), () => t('progress', { current: index + 1, total: totalSteps() }));
  $('anamnesisStepTitle').setAttribute('data-i18n', `anamnesis.steps.${step.id}.title`);
  $('anamnesisStepTitle').textContent = t(`steps.${step.id}.title`);
  $('anamnesisStepIntro').setAttribute('data-i18n', `anamnesis.steps.${step.id}.intro`);
  $('anamnesisStepIntro').textContent = t(`steps.${step.id}.intro`);
  const container = $('anamnesisStepFields');
  container.textContent = '';
  stepDatePicker = null;
  fields = step.items.map((item) => buildField(item, data.anamnesis.answers[item.key]));
  for (const field of fields) container.appendChild(field.element);
  if (step.id === 'experience') container.appendChild(experienceNotes());
  if (step.id === 'health') container.appendChild(consentControl());
  const runs = fields.find((field) => field.key === 'runs_per_week');
  if (runs) {
    runs.inputs[0].addEventListener('input', syncDependents);
    runs.element.addEventListener('change', syncDependents);
    syncDependents();
  }
  $('anamnesisFormError').hidden = true;
  $('anamnesisBack').hidden = mode === 'edit' || index === 0;
  $('anamnesisCancel').hidden = mode !== 'edit';
  const next = $('anamnesisNext');
  next.setAttribute('data-i18n', mode === 'edit' ? 'anamnesis.actions.save' : 'anamnesis.actions.next');
  next.textContent = mode === 'edit' ? t('actions.save') : t('actions.next');
  refreshIcons();
  if (focus) $('anamnesisStepTitle').focus();
}

function experienceNotes() {
  const wrapper = el('div', 'field anamnesis-item');
  const textarea = el('textarea', 'prompt-textarea', { id: 'q-experience-notes', rows: '4', maxlength: '2000', 'aria-describedby': 'q-experience-notes-hint' });
  textarea.value = data.experience.value;
  const label = el('label', 'field-label', { for: textarea.id });
  bind(label, () => t('experienceNotes.label'));
  const hint = el('p', 'field-hint', { id: 'q-experience-notes-hint' });
  bind(hint, () => t('experienceNotes.hint'));
  wrapper.append(label, hint, textarea);
  return wrapper;
}

function consentControl() {
  const wrapper = el('div', 'field anamnesis-consent');
  const chip = el('label', 'preference-choice anamnesis-consent-choice');
  const input = el('input', '', { id: 'q-sensitive-consent', type: 'checkbox', 'aria-describedby': 'q-sensitive-consent-hint' });
  input.checked = data.anamnesis.sensitive_ai_consent;
  const text = el('span');
  bind(text, () => t('consent.label'));
  chip.append(input, text);
  const hint = el('p', 'field-hint', { id: 'q-sensitive-consent-hint' });
  bind(hint, () => t('consent.hint'));
  wrapper.append(chip, hint);
  return wrapper;
}

function showFormError(code) {
  const box = $('anamnesisFormError');
  box.textContent = t(`errors.${knownError(code) ? code : 'generic'}`);
  box.hidden = false;
}

async function saveStep(event) {
  event.preventDefault();
  if (busy) return;
  $('anamnesisFormError').hidden = true;
  const answers = {};
  let weight = null;
  let firstInvalid = null;
  for (const field of fields) {
    field.clearError();
    if (field.hiddenAsNotApplicable) continue;
    const result = field.collect();
    if (result.missing) field.showError('required');
    else if (result.error) field.showError(result.error, result.params);
    else {
      answers[field.key] = result.answer;
      if (result.weight) weight = result.weight;
      continue;
    }
    firstInvalid ??= field;
  }
  if (firstInvalid) { firstInvalid.focus(); return; }
  const step = questionSteps()[stepIndex];
  const notes = step.id === 'experience' ? $('q-experience-notes').value : null;
  const consent = step.id === 'health' ? $('q-sensitive-consent').checked : undefined;
  busy = true;
  $('anamnesisNext').disabled = true;
  try {
    if (weight) {
      try {
        const created = await api('POST', '/api/body-weights', weight);
        data.weights = [created.weight, ...data.weights].sort((a, b) => b.measured_on.localeCompare(a.measured_on));
        renderWeights();
      } catch (error) {
        const field = fields.find((item) => item.key === 'weight');
        field.showError(error.code, error.code === 'weightOutOfRange' ? weightRange() : undefined);
        field.focus();
        return;
      }
    }
    const saved = await api('PUT', '/api/anamnesis', {
      answers,
      expected_revision: data.anamnesis.revision,
      ...(consent === undefined ? {} : { sensitive_ai_consent: consent }),
    });
    data.anamnesis = saved.anamnesis;
    if (notes !== null && notes !== data.experience.value) {
      const profile = await api('PUT', '/api/ai/profile', { fields: { experience: notes }, expected_version: data.experience.version });
      data.experience = { value: profile.profile.fields.experience?.value ?? notes, version: profile.profile.version };
    }
    renderStatus();
    if (mode === 'edit') {
      showShellToast(i18n.messages, 'anamnesis.toasts.saved');
      showReview();
    } else if (stepIndex + 1 < questionSteps().length) renderStep(stepIndex + 1);
    else showReview();
  } catch (error) {
    const field = fields.find((item) => item.key === error.field);
    if (field) {
      field.showError(error.code, field.item.min !== undefined ? rangeParams(field.item) : undefined);
      field.focus();
    } else {
      showFormError(error.code);
      $('anamnesisFormError').focus?.();
    }
  } finally {
    busy = false;
    $('anamnesisNext').disabled = false;
  }
}

/* ── Review and summary ──────────────────────────────────────── */

function showReview({ focus = true } = {}) {
  mode = 'review';
  bindings = [];
  fields = [];
  $('anamnesisWizard').hidden = true;
  $('anamnesisReview').hidden = false;
  $('anamnesisReviewError').hidden = true;
  renderSummary();
  if (focus) $('anamnesisReviewTitle').focus();
}

function renderSummary() {
  const completed = data.anamnesis.status === 'completed';
  $('anamnesisReviewIntro').setAttribute('data-i18n', 'anamnesis.steps.review.intro');
  $('anamnesisReviewIntro').textContent = completed
    ? t('completedOn', { date: formatDate(String(data.anamnesis.completed_at).slice(0, 10), i18n.language) })
    : t('steps.review.intro');
  if (completed) $('anamnesisReviewIntro').removeAttribute('data-i18n');
  $('anamnesisReviewActions').hidden = completed;
  const heading = completed ? 'answersTitle' : 'steps.review.title';
  $('anamnesisReviewTitle').setAttribute('data-i18n', `anamnesis.${heading}`);
  $('anamnesisReviewTitle').textContent = t(heading);
  const missing = new Set(data.anamnesis.missing);
  const summary = $('anamnesisSummary');
  const focusedEdit = summary.contains(document.activeElement) ? document.activeElement.dataset.step : null;
  summary.textContent = '';
  questionSteps().forEach((step, index) => {
    const section = el('section', 'shoe-card anamnesis-card anamnesis-summary-step', { 'aria-labelledby': `summary-${step.id}` });
    const header = el('div', 'anamnesis-summary-header');
    const title = el('h3', '', { id: `summary-${step.id}` });
    title.textContent = t(`steps.${step.id}.title`);
    const edit = el('button', 'btn-secondary', { type: 'button', 'data-step': step.id });
    edit.textContent = t('actions.edit');
    edit.setAttribute('aria-label', `${t('actions.edit')}: ${t(`steps.${step.id}.title`)}`);
    edit.addEventListener('click', () => { mode = data.anamnesis.status === 'completed' ? 'edit' : 'wizard'; renderStep(index); });
    header.append(title, edit);
    const list = el('dl', 'anamnesis-answers');
    const row = (label, value, pending = false) => {
      const wrapper = el('div', pending ? 'is-missing' : '');
      const dt = el('dt');
      dt.textContent = label;
      const dd = el('dd');
      dd.textContent = value;
      wrapper.append(dt, dd);
      list.appendChild(wrapper);
    };
    for (const item of step.items) {
      const unit = item.type === 'distance' ? prefs().distance_unit : null;
      row(t(`items.${item.key}.label`, { unit }), formatAnswer(item, data.anamnesis.answers[item.key]), missing.has(item.key));
    }
    if (step.id === 'experience') row(t('experienceNotes.label'), data.experience.value || t('answers.none'));
    if (step.id === 'health') row(t('consent.summary'), data.anamnesis.sensitive_ai_consent ? t('consent.on') : t('consent.off'));
    section.append(header, list);
    summary.appendChild(section);
  });
  if (focusedEdit) summary.querySelector(`button[data-step="${focusedEdit}"]`)?.focus();
}

async function complete() {
  if (busy) return;
  const box = $('anamnesisReviewError');
  box.hidden = true;
  if (data.anamnesis.missing.length) {
    box.textContent = t('review.missing');
    box.hidden = false;
    const step = questionSteps()[firstIncompleteStep()];
    $('anamnesisSummary').querySelector(`button[data-step="${step.id}"]`)?.focus();
    return;
  }
  busy = true;
  $('anamnesisComplete').disabled = true;
  try {
    const saved = await api('POST', '/api/anamnesis/complete', { expected_revision: data.anamnesis.revision });
    data.anamnesis = saved.anamnesis;
    renderStatus();
    renderSummary();
    showShellToast(i18n.messages, 'anamnesis.toasts.completed');
    $('anamnesisReviewTitle').focus();
  } catch (error) {
    box.textContent = t(`errors.${knownError(error.code) ? error.code : 'generic'}`);
    box.hidden = false;
  } finally {
    busy = false;
    $('anamnesisComplete').disabled = false;
  }
}

function renderStatus() {
  const badge = $('anamnesisStatus');
  badge.hidden = false;
  badge.className = `anamnesis-badge status-${data.anamnesis.status}`;
  badge.textContent = t(`status.${data.anamnesis.status}`);
}

/* ── Weight log ──────────────────────────────────────────────── */

function renderWeights() {
  $('weightValueLabel').textContent = t('weight.value', { unit: weightUnitLabel(prefs().body_unit) });
  const list = $('weightList');
  const focused = list.contains(document.activeElement) ? `${document.activeElement.dataset.id}:${document.activeElement.dataset.action}` : null;
  list.textContent = '';
  $('weightEmpty').hidden = data.weights.length > 0;
  for (const entry of data.weights) {
    const item = el('li', 'anamnesis-weight-row');
    const date = formatDate(entry.measured_on, i18n.language);
    const text = el('span');
    text.textContent = `${date} · ${formatWeight(entry.weight_kg, prefs().body_unit)}`;
    const actions = el('div', 'anamnesis-weight-actions');
    for (const [action, icon, key] of [['edit', 'pencil', 'weightLog.edit'], ['delete', 'trash-2', 'weightLog.delete']]) {
      const button = el('button', `btn-icon${action === 'delete' ? ' anamnesis-danger' : ''}`, { type: 'button', 'data-id': String(entry.id), 'data-action': action, 'aria-label': t(key, { date }) });
      button.innerHTML = `<i data-lucide="${icon}"></i>`;
      const tooltip = el('span', 'custom-tooltip', { 'aria-hidden': 'true' });
      tooltip.textContent = t(key, { date });
      button.appendChild(tooltip);
      button.addEventListener('click', () => (action === 'edit' ? startWeightEdit(entry, button) : removeWeight(entry, button)));
      actions.appendChild(button);
    }
    item.append(text, actions);
    list.appendChild(item);
  }
  if (focused) list.querySelector(`button[data-id="${focused.split(':')[0]}"][data-action="${focused.split(':')[1]}"]`)?.focus();
  refreshIcons();
}

function weightFieldError(id, code, params) {
  const error = $(`${id}Error`);
  error.textContent = t(`errors.${knownError(code) ? code : 'generic'}`, params);
  error.hidden = false;
  $(id).setAttribute('aria-invalid', 'true');
  $(id).focus();
}

function clearWeightErrors() {
  for (const id of ['weightValue', 'weightDate']) {
    $(`${id}Error`).hidden = true;
    $(id).removeAttribute('aria-invalid');
  }
}

function startWeightEdit(entry, trigger) {
  editingWeight = { entry, trigger };
  $('weightValue').value = String(Math.round(weightFromKg(entry.weight_kg, prefs().body_unit) * 10) / 10);
  weightPicker?.setValue(entry.measured_on);
  $('weightSubmit').setAttribute('data-i18n', 'anamnesis.actions.save');
  $('weightSubmit').textContent = t('actions.save');
  $('weightCancel').hidden = false;
  $('weightValue').focus();
}

function stopWeightEdit({ restore = false } = {}) {
  const trigger = editingWeight?.trigger;
  editingWeight = null;
  $('weightValue').value = '';
  weightPicker?.setValue(data.today);
  $('weightSubmit').setAttribute('data-i18n', 'anamnesis.weightLog.add');
  $('weightSubmit').textContent = t('weightLog.add');
  $('weightCancel').hidden = true;
  clearWeightErrors();
  if (restore && trigger?.isConnected) trigger.focus();
}

async function submitWeight(event) {
  event.preventDefault();
  if (busy) return;
  clearWeightErrors();
  const typed = parseNumber($('weightValue').value);
  if (typed === null || Number.isNaN(typed)) return weightFieldError('weightValue', 'invalidWeight');
  const kg = weightToKg(typed, prefs().body_unit);
  if (kg < WEIGHT_RANGE_KG.min || kg > WEIGHT_RANGE_KG.max) return weightFieldError('weightValue', 'weightOutOfRange', weightRange());
  const body = { measured_on: weightPicker?.getValue() || data.today, weight_kg: Math.round(kg * 100) / 100 };
  busy = true;
  $('weightSubmit').disabled = true;
  try {
    if (editingWeight) {
      const id = editingWeight.entry.id;
      const saved = await api('PATCH', `/api/body-weights/${id}`, body);
      data.weights = data.weights.map((entry) => (entry.id === id ? saved.weight : entry));
    } else {
      const saved = await api('POST', '/api/body-weights', body);
      data.weights = [saved.weight, ...data.weights];
    }
    data.weights.sort((a, b) => b.measured_on.localeCompare(a.measured_on) || b.id - a.id);
    const wasEditing = Boolean(editingWeight);
    stopWeightEdit({ restore: wasEditing });
    renderWeights();
    await refreshAnamnesis();
    showShellToast(i18n.messages, 'anamnesis.toasts.weightSaved');
  } catch (error) {
    weightFieldError(error.field === 'measured_on' ? 'weightDate' : 'weightValue', error.code, error.code === 'weightOutOfRange' ? weightRange() : undefined);
  } finally {
    busy = false;
    $('weightSubmit').disabled = false;
  }
}

async function removeWeight(entry, trigger) {
  if (busy) return;
  const date = formatDate(entry.measured_on, i18n.language);
  const confirmed = await showConfirm({ title: t('weightLog.deleteTitle'), message: t('weightLog.deleteConfirm', { date }), confirmLabel: t('weightLog.deleteTitle'), cancelLabel: t('actions.cancel') });
  if (!confirmed) { trigger.focus(); return; }
  busy = true;
  try {
    await api('DELETE', `/api/body-weights/${entry.id}`);
    const index = data.weights.findIndex((item) => item.id === entry.id);
    data.weights = data.weights.filter((item) => item.id !== entry.id);
    if (editingWeight?.entry.id === entry.id) stopWeightEdit();
    renderWeights();
    await refreshAnamnesis();
    showShellToast(i18n.messages, 'anamnesis.toasts.weightDeleted');
    const next = $('weightList').querySelectorAll('button[data-action="delete"]')[Math.min(index, data.weights.length - 1)];
    (next || $('weightValue')).focus();
  } catch (error) {
    showShellToast(i18n.messages, `anamnesis.errors.${knownError(error.code) ? error.code : 'generic'}`, 'error', 4000);
    trigger.focus();
  } finally {
    busy = false;
  }
}

// The weight log can satisfy or stop satisfying the weight question, so the
// questionnaire's derived missing list is re-read after a log change.
async function refreshAnamnesis() {
  try {
    const fresh = await api('GET', '/api/anamnesis');
    data.anamnesis = fresh.anamnesis;
    renderStatus();
    if (mode === 'review') renderSummary();
  } catch {
    /* The log change itself succeeded; the summary refreshes on the next load. */
  }
}

/* ── Data controls ───────────────────────────────────────────── */

async function deleteEverything() {
  if (busy) return;
  const confirmed = await showConfirm({ title: t('privacy.deleteTitle'), message: t('privacy.deleteConfirm'), confirmLabel: t('privacy.deleteTitle'), cancelLabel: t('actions.cancel') });
  if (!confirmed) { $('anamnesisDelete').focus(); return; }
  busy = true;
  try {
    await api('DELETE', '/api/anamnesis');
    busy = false;
    await load({ focusTitle: true });
    showShellToast(i18n.messages, 'anamnesis.toasts.deleted');
  } catch (error) {
    showShellToast(i18n.messages, `anamnesis.errors.${knownError(error.code) ? error.code : 'generic'}`, 'error', 4000);
  } finally {
    busy = false;
  }
}

/* ── Load and wiring ─────────────────────────────────────────── */

async function load({ focusTitle = false } = {}) {
  $('anamnesisLoading').hidden = false;
  $('anamnesisLoadError').hidden = true;
  try {
    data = await api('GET', '/api/anamnesis');
  } catch {
    $('anamnesisLoading').hidden = true;
    $('anamnesisLoadError').hidden = false;
    return;
  }
  $('anamnesisLoading').hidden = true;
  for (const id of ['weightLog', 'anamnesisPrivacy']) $(id).hidden = false;
  stopWeightEdit();
  renderStatus();
  renderWeights();
  const incomplete = firstIncompleteStep();
  if (data.anamnesis.status === 'completed' || incomplete === -1) showReview({ focus: focusTitle });
  else {
    mode = 'wizard';
    renderStep(incomplete, { focus: focusTitle });
  }
  if (focusTitle) $('anamnesisTitle').focus();
}

async function initAnamnesis() {
  const user = await initShell();
  if (!user) return;
  i18n = getShellI18n();
  const cancel = el('button', 'btn-secondary', { id: 'weightCancel', type: 'button', 'data-i18n': 'anamnesis.actions.cancel' });
  cancel.textContent = t('actions.cancel');
  cancel.hidden = true;
  cancel.addEventListener('click', () => stopWeightEdit({ restore: true }));
  $('weightSubmit').before(cancel);
  weightPicker = createDatePicker($('weightDate'), { getLanguage: () => i18n.language, getWeekStart: () => prefs().first_day_of_week });
  $('anamnesisForm').addEventListener('submit', saveStep);
  $('anamnesisBack').addEventListener('click', () => { if (!busy && stepIndex > 0) renderStep(stepIndex - 1); });
  $('anamnesisCancel').addEventListener('click', () => showReview());
  $('anamnesisComplete').addEventListener('click', complete);
  $('anamnesisRetry').addEventListener('click', () => load());
  $('weightForm').addEventListener('submit', submitWeight);
  $('anamnesisDelete').addEventListener('click', deleteEverything);
  $('anamnesisOpenPreferences').addEventListener('click', () => openPreferencesModal());
  document.addEventListener('app:languagechange', () => {
    if (!data) return;
    bindings.forEach((update) => update());
    renderStatus();
    renderWeights();
    if (mode === 'review') renderSummary();
    weightPicker?.refresh();
    stepDatePicker?.refresh();
  });
  document.addEventListener('kinesis:preferences-changed', () => {
    if (!data) return;
    renderWeights();
    if (mode === 'review') renderSummary();
    else renderStep(stepIndex, { focus: false });
  });
  await load();
}

if (typeof document !== 'undefined' && document.getElementById('appView')) initAnamnesis();
