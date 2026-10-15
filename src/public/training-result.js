import {
  HR_SOURCE_LABEL_KEYS,
  TERRAIN_LABEL_KEYS,
  BREATHING_LABEL_KEYS,
  MUSCLE_LABEL_KEYS,
  ENERGY_LABEL_KEYS,
  formatDateLabel,
  resolveResultSource,
  templateFor,
  buildAnalysisPrompt,
  painPromptText,
  buildCanonicalPromptForm,
  collectPromptValues,
  formatCadence,
  splitPaceLabel,
  formatLapType,
} from './shared/analysis-prompts.js';
export * from './shared/analysis-prompts.js';
import { initShell, getShellI18n, getUserPreferences, showConfirm, showShellToast, refreshIcons } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate as formatLocalizedDate, formatWeekday } from './shared/date.js';
import { fetchTraining, saveTrainingFeedback, saveManualTrainingResults, fetchShoes, deleteTraining, fetchWeather } from './shared/api.js';
import { KM_TO_MILES, convertDistanceInputValue, convertDistanceToKm, formatDistance, formatPaceFromMetric, formatTemperature } from './shared/units.js';
import { createImportGuidance } from './shared/workout-import-guidance.js';
import { createWorkoutCreationGuidance } from './shared/workout-creation-guidance.js';

export function selectableFeedbackShoes(shoes, selectedId = null) {
  const owned = Array.isArray(shoes) ? shoes : [];
  return owned.filter((shoe) => shoe.status === 'active' ||
    (shoe.status === 'retired' && shoe.id === selectedId));
}

// Sessions open contextually via /training-result.html?id=<id>; without an
// id there is nothing to show, so the page bounces back to the calendar.
export function resolveSessionId(search) {
  const raw = new URLSearchParams(search).get('id');
  const id = raw === null ? '' : raw.trim();
  return id === '' ? null : id;
}

export function plannedValue(training, field) {
  const value = training?.[field];
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

// '' / blank -> null (unanswered), integer 1..5 kept, anything else -> NaN.
export function normalizeFeedbackRpe(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : NaN;
}

// Concluding a realized result (or asking for its analysis) requires one
// reported RPE. An unanswered group and an out-of-range value are equally
// unusable, so both are refused before any write or prompt is produced.
export function isAnsweredFeedbackRpe(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

export const WEATHER_CODE_LABEL_KEYS = {
  0: 'weather.0',
  1: 'weather.1',
  2: 'weather.2',
  3: 'weather.3',
  45: 'weather.45',
  48: 'weather.48',
  51: 'weather.51',
  53: 'weather.53',
  55: 'weather.55',
  56: 'weather.56',
  57: 'weather.57',
  61: 'weather.61',
  63: 'weather.63',
  65: 'weather.65',
  66: 'weather.66',
  67: 'weather.67',
  71: 'weather.71',
  73: 'weather.73',
  75: 'weather.75',
  77: 'weather.77',
  80: 'weather.80',
  81: 'weather.81',
  82: 'weather.82',
  85: 'weather.85',
  86: 'weather.86',
  95: 'weather.95',
  96: 'weather.96',
  99: 'weather.99',
};
export const WEATHER_UNKNOWN_KEY = 'weather.unknown';

export function weatherLabelKey(code) {
  return WEATHER_CODE_LABEL_KEYS[code] ?? WEATHER_UNKNOWN_KEY;
}

export function shouldAutoFillWeather(training, currentValue = '') {
  return (
    String(training?.location ?? '').trim() !== '' &&
    String(currentValue ?? '').trim() === ''
  );
}

export function formatWeatherAutofill(weather, translateFn, unit = 'C') {
  if (!weather || typeof weather.temperature_c !== 'number') return '';
  const temperature = formatTemperature(weather.temperature_c, unit);
  const label = translateFn(weatherLabelKey(weather.weather_code));
  return `${temperature}, ${label}`;
}

// The .FIT upload only makes sense when a watch was actually used.
export function isFitFieldVisible(smartwatchValue) {
  return smartwatchValue === 'sim';
}

export function manualResultsPayload(values, distanceUnit = 'km', feedbackRpe = null) {
  const hours = Number(values.hours || 0);
  const minutes = Number(values.minutes || 0);
  const seconds = Number(values.seconds || 0);
  const distance = Number(values.distance);
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isInteger(hours) || hours < 0 ||
    !Number.isInteger(minutes) || minutes < 0 || minutes > 59 ||
    !Number.isInteger(seconds) || seconds < 0 || seconds > 59) return null;
  const duration_seconds = hours * 3600 + minutes * 60 + seconds;
  if (duration_seconds <= 0) return null;
  const optionalNumber = (value) => String(value ?? '').trim() === '' ? null : Number(value);
  const payload = {
    distance_km: convertDistanceToKm(distance, distanceUnit), duration_seconds,
    avg_hr: optionalNumber(values.avg_hr), max_hr: optionalNumber(values.max_hr),
    elevation_gain_m: optionalNumber(values.elevation_gain_m), calories: optionalNumber(values.calories),
  };
  // The manual write concludes the workout, so the reported effort travels with
  // the metrics; the backend refuses the write when neither is present.
  if (isAnsweredFeedbackRpe(feedbackRpe)) payload.feedback_rpe = feedbackRpe;
  return payload;
}

export function syncManualDistanceUnit({ value, previousUnit = 'km', nextUnit = 'km' }) {
  const previous = previousUnit === 'mi' ? 'mi' : 'km';
  const next = nextUnit === 'mi' ? 'mi' : 'km';
  if (previous === next) return { value, unit: next, changed: false };
  const converted = convertDistanceInputValue(value, previous, next);
  return { value: converted === null ? value : String(converted), unit: next, changed: converted !== null };
}

export function resultSourceBadgeKey(source) {
  if (source === 'manual') return 'session.sourceManualBadge';
  if (source === 'fit_upload') return 'session.sourceFitBadge';
  return null;
}

function durationSeconds(value) {
  const parts = String(value ?? '').split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isInteger)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isInteger)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function manualResultsMatchTraining(payload, training = {}) {
  if (training.result_data_source !== 'manual') return false;
  const optionalFields = [
    ['avg_hr', 'fit_avg_hr'],
    ['max_hr', 'fit_max_hr'],
    ['elevation_gain_m', 'fit_elevation_gain'],
    ['calories', 'fit_calories'],
  ];
  return Number(training.fit_distance) === payload.distance_km
    && durationSeconds(training.fit_duration) === payload.duration_seconds
    && optionalFields.every(([payloadKey, trainingKey]) => (training[trainingKey] ?? null) === payload[payloadKey]);
}

// Both terminal actions use this single workflow. It returns expected user
// outcomes instead of throwing for a normal cancellation or invalid form.
export async function persistManualResultsIfNeeded({
  selectedSource,
  values,
  distanceUnit,
  feedbackRpe,
  training,
  save,
  confirmReplaceFit,
  applyResponse,
}) {
  if (selectedSource !== 'manual') return { status: 'not-needed' };
  const payload = manualResultsPayload(values, distanceUnit, feedbackRpe);
  if (!payload) return { status: 'invalid' };
  if (manualResultsMatchTraining(payload, training)) return { status: 'not-needed' };
  if (training.result_data_source === 'fit_upload') {
    const confirmed = await confirmReplaceFit();
    if (!confirmed) return { status: 'cancelled' };
    payload.confirm_replace_fit = true;
  }
  try {
    const response = await save(payload);
    applyResponse(response);
    return { status: 'saved', response };
  } catch (error) {
    return { status: 'error', error };
  }
}

// Both terminal actions persist the complete form before doing anything
// action-specific. The caller supplies the current state and the API hooks so
// the ordering remains explicit and easy to test.
export async function persistCurrentTrainingState({
  collectState,
  persistManual,
  saveFeedback,
  applyTraining,
}) {
  const collected = collectState();
  if (collected?.status === 'invalid') return collected;
  let manualResult;
  try {
    manualResult = await persistManual();
  } catch (error) {
    return { status: 'error', error, stage: 'result' };
  }
  if (['invalid', 'cancelled', 'error'].includes(manualResult.status)) return manualResult;
  try {
    const response = await saveFeedback(collected.payload);
    if (!response?.training) return { status: 'error', error: new Error('Invalid training response.') };
    applyTraining(response.training);
    return { status: 'saved', training: response.training };
  } catch (error) {
    return { status: 'error', error, stage: 'feedback' };
  }
}

// Local weekday name ('YYYY-MM-DD' parsed as a local date, never UTC).
// Neutralizes HTML-significant characters so file names coming from the
// operating system can never inject markup into the dropzone.
export function escapeHtmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Renders the dropzone primary line: the translated drag invitation while no
// file is picked, or "File selected: <name>" once one is chosen. The name is
// always escaped because it is injected as markup.
export function fitDropzonePrimaryHtml({ files, translate }) {
  const file = files && files.length > 0 ? files[0] : null;
  if (!file) {
    return translate('session.fitDragText');
  }
  const prefix = escapeHtmlText(translate('session.fitSelected'));
  return `${prefix}<strong>${escapeHtmlText(file.name)}</strong>`;
}

const FIT_UPLOAD_ERROR_KEYS = {
  invalid_file: 'session.errors.fitInvalidFile',
  invalid_zip: 'session.errors.fitInvalidZip',
  missing_fit: 'session.errors.fitMissingInZip',
  multiple_fit: 'session.errors.fitMultipleInZip',
  encrypted_zip: 'session.errors.fitEncryptedZip',
  unsafe_entry: 'session.errors.fitUnsafeZip',
  too_many_entries: 'session.errors.fitTooManyEntries',
  fit_too_large: 'session.errors.fitTooLarge',
  zip_too_large: 'session.errors.fitZipTooLarge',
  unsupported_type: 'session.errors.fitUnsupportedType',
};

export function fitUploadErrorMessage(code, translate) {
  const key = FIT_UPLOAD_ERROR_KEYS[code];
  return key ? translate(key) : translate('session.errors.fitUpload');
}

// Copies through the async Clipboard API. Returns true on success so the UI
// can flip to its "Copied!" feedback state.
export async function copyAnalysisPrompt(text, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return false;
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const PLANNED_FIELDS = [
  ['tipo', 'plannedTipo'],
  ['treino', 'plannedTreino'],
  ['detalhes', 'plannedDetalhes'],
  ['fc_alvo', 'plannedFcAlvo'],
  ['rpe', 'plannedRpe'],
  ['tenis', 'plannedTenis'],
  ['location', 'plannedLocation'],
];

// Whole delete flow, kept dependency-injectable so it can be unit-tested
// without a DOM. Returns true only when the session was actually removed.
export async function handleTrainingDelete({
  id,
  messages,
  confirm = showConfirm,
  remove = deleteTraining,
  toast = showShellToast,
  redirect = () => window.location.replace('/calendar.html'),
}) {
  const t = (key) => translate(messages, key);
  const confirmed = await confirm({
    title: t('session.deleteConfirmTitle'),
    message: t('session.deleteConfirmMessage'),
    icon: 'trash-2',
    confirmLabel: t('shell.confirm.yes'),
    cancelLabel: t('shell.confirm.no'),
  });
  if (!confirmed) return false;
  try {
    await remove(id);
    toast(messages, 'session.deleteSuccess', 'success');
    redirect();
    return true;
  } catch {
    toast(messages, 'session.deleteError', 'error');
    return false;
  }
}

async function initTrainingResult() {
  const statusEl = document.getElementById('status');
  const dateEl = document.getElementById('sessionDate');
  const saveBtn = document.getElementById('saveBtn');
  const rpeSelector = document.getElementById('feedbackRpe');
  const rpeError = document.getElementById('feedbackRpeError');
  const notesInput = document.getElementById('feedbackNotas');
  const resultSourceSelect = document.getElementById('resultSourceSelect');
  const fitField = document.getElementById('fitField');
  const fitFileInput = document.getElementById('fitFile');
  const fitDropzone = document.getElementById('fitDropzone');
  const fitDropzonePrimary = fitDropzone.querySelector('.dropzone-text-primary');
  const shoeSelect = document.getElementById('feedbackShoe');
  const hrSourceSelect = document.getElementById('hrSourceSelect');
  const weatherInput = document.getElementById('feedbackWeather');
  const weatherSpinner = document.getElementById('weatherSpinner');
  const terrainInput = document.getElementById('feedbackTerrain');
  const breathingInput = document.getElementById('feedbackBreathing');
  const muscleInput = document.getElementById('feedbackMuscle');
  const energyInput = document.getElementById('feedbackEnergy');
  const hasPainSelect = document.getElementById('feedbackHasPain');
  const painDescriptionField = document.getElementById('painDescriptionContainer');
  const painInput = document.getElementById('feedbackPain');
  const generateBtn = document.getElementById('generateBtn');
  const generateLabel = generateBtn.querySelector('span');
  const promptSection = document.getElementById('promptSection');
  const promptOutput = document.getElementById('promptOutput');
  const copyPromptBtn = document.getElementById('copyPromptBtn');
  const copyLabel = copyPromptBtn.querySelector('span');
  const deleteTrainingBtn = document.getElementById('deleteTrainingBtn');
  const fitDataSection = document.getElementById('fitDataSection');
  const fitLapsSection = document.getElementById('fitLapsSection');
  const fitLapsBody = document.getElementById('fitLapsBody');
  const manualResultsField = document.getElementById('manualResultsField');
  const resultSourceBadge = document.getElementById('resultSourceBadge');
  const manualDistanceUnit = document.getElementById('manualDistanceUnit');
  const importHelpBtn = document.getElementById('importHelpBtn');
  const importHelpDialog = document.getElementById('importHelpDialog');
  const workoutCreationBtn = document.getElementById('workoutCreationBtn');
  const workoutCreationDialog = document.getElementById('workoutCreationDialog');
  const manualInputs = {
    distance: document.getElementById('manualDistance'), hours: document.getElementById('manualHours'),
    minutes: document.getElementById('manualMinutes'), seconds: document.getElementById('manualSeconds'),
    avg_hr: document.getElementById('manualAvgHr'), max_hr: document.getElementById('manualMaxHr'),
    elevation_gain_m: document.getElementById('manualElevation'), calories: document.getElementById('manualCalories'),
  };

  let i18n = null;
  let copiedTimer = null;
  let fitData = null;
  let currentTrainingId = null;
  let training = null;
  let promptText = '';
  let manualDistanceInputUnit = 'km';
  let rpeErrorKey = null;
  const t = (key) => translate(i18n ? i18n.messages : {}, key);

  const applyTooltips = () => {
    rpeSelector.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
  };

  const setStatus = (message, tone = '') => {
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  };

  const currentFeedbackRpe = () =>
    normalizeFeedbackRpe(rpeSelector.querySelector('input[type="radio"]:checked')?.value ?? '');

  // The realized RPE is the one field every result mutation, prompt generation
  // and navigation depends on. Missing or unusable values stop the action
  // before any request, report the problem inside the group, mark it invalid
  // and park focus on the first option so the keyboard user can answer there.
  // Nothing typed elsewhere in the form is touched.
  const requireFeedbackRpe = () => {
    const rpe = currentFeedbackRpe();
    if (isAnsweredFeedbackRpe(rpe)) return rpe;
    rpeErrorKey = 'session.errors.rpeRequired';
    rpeError.textContent = t(rpeErrorKey);
    rpeError.hidden = false;
    rpeSelector.setAttribute('aria-invalid', 'true');
    rpeSelector.setAttribute('aria-describedby', 'feedbackRpeError');
    setStatus(t(rpeErrorKey), 'error');
    rpeSelector.querySelector('input[type="radio"]')?.focus();
    return null;
  };

  const clearFeedbackRpeError = () => {
    if (!rpeErrorKey) return;
    rpeErrorKey = null;
    rpeError.textContent = '';
    rpeError.hidden = true;
    rpeSelector.removeAttribute('aria-invalid');
    rpeSelector.removeAttribute('aria-describedby');
    // Only the message this group raised is taken back; a failure reported by
    // the save flow keeps the status the user still needs.
    if (statusEl.dataset.tone === 'error' && statusEl.textContent) setStatus('');
  };
  rpeSelector.addEventListener('change', clearFeedbackRpeError);

  const syncResultSourceVisibility = () => {
    const manual = resultSourceSelect.value === 'manual';
    fitField.hidden = manual;
    manualResultsField.hidden = !manual;
  };
  const renderManualDistanceUnit = ({ convertExisting = false } = {}) => {
    const nextUnit = getUserPreferences().distance_unit === 'mi' ? 'mi' : 'km';
    if (convertExisting) {
      const synced = syncManualDistanceUnit({
        value: manualInputs.distance.value,
        previousUnit: manualDistanceInputUnit,
        nextUnit,
      });
      manualInputs.distance.value = synced.value;
    }
    manualDistanceInputUnit = nextUnit;
    manualDistanceUnit.textContent = nextUnit;
  };
  resultSourceSelect.addEventListener('change', syncResultSourceVisibility);

  // The dropzone mirrors the hidden input's state: the drag invitation while
  // empty, the chosen file name once one is picked.
  const renderFitDropzoneState = () => {
    fitDropzonePrimary.innerHTML = fitDropzonePrimaryHtml({
      files: fitFileInput.files,
      translate: t,
    });
  };
  fitFileInput.addEventListener('change', renderFitDropzoneState);
  fitDropzone.addEventListener('dragover', () => fitDropzone.classList.add('drag-active'));
  fitDropzone.addEventListener('dragleave', () =>
    fitDropzone.classList.remove('drag-active')
  );
  fitDropzone.addEventListener('drop', () => fitDropzone.classList.remove('drag-active'));

  const renderLapsTable = () => {
    const laps = fitData?.laps;
    if (!Array.isArray(laps) || laps.length === 0) {
      fitLapsSection.hidden = true;
      fitLapsBody.innerHTML = '';
      return;
    }
    fitLapsSection.hidden = false;
    fitLapsTable.lang = i18n.language;
    const english = i18n.language === 'en-US';
    const softBreaks = {
      fitLapDistance: english ? 'Dis\u00adtance' : 'Dis\u00adtância',
      fitLapDuration: english ? 'Dur\u00adation' : 'Dur\u00adação',
      fitLapHrUnit: english ? 'av\u00adg.' : 'mé\u00addia',
      fitLapCadence: english ? 'Cad\u00adence' : 'Cadên\u00adcia',
      fitLapAscent: english ? 'As\u00adcent' : 'Subi\u00adda',
    };
    for (const [key, label] of Object.entries(softBreaks)) {
      const header = fitLapsTable.querySelector(`.fit-lap-header-label[data-i18n="session.${key}"]`);
      if (!header) continue;
      const fullLabel = t(`session.${key}`);
      header.textContent = label;
      if (key !== 'fitLapHrUnit') {
        const accessibleKey = key === 'fitLapCadence'
          ? 'session.fitLapCadenceAccessible'
          : key === 'fitLapAscent' ? 'session.fitLapAscentAccessible' : null;
        header.closest('th')?.setAttribute('aria-label', accessibleKey ? t(accessibleKey) : fullLabel);
      }
    }
    const fragment = document.createDocumentFragment();
    const distanceUnit = getUserPreferences().distance_unit;
    for (const lap of laps) {
      const tr = document.createElement('tr');
      const distance = lap.distanceLabel ?? '-';
      const duration = lap.durationLabel ?? '-';
      const pace = formatPaceFromMetric(lap.avgPaceLabel ?? '-', distanceUnit);
      const paceParts = splitPaceLabel(pace);
      const hr = lap.avgHeartRate ?? '-';
      const cadence = formatCadence(lap.avgCadenceSpm, i18n.language);
      const ascent = lap.ascentMeters != null ? String(lap.ascentMeters) : '-';
      const distanceValue = distance === '-'
        ? '-'
        : formatDistance(distance, distanceUnit).replace(/\s(km|mi)$/, '');
      const displayDistance = distance === '-' ? '-' : `${distanceValue} ${distanceUnit}`;
      const type = formatLapType(lap.stepType, i18n.language, i18n.messages);
      const warmup = t('session.fitLapTypes.warmup');
      const cooldown = t('session.fitLapTypes.cooldown');
      const displayType = type === warmup
        ? (english ? 'Warm\u00adup' : 'Aque\u00adci\u00admen\u00adto')
        : type === cooldown
          ? (english ? 'Cool\u00addown' : 'Desa\u00adque\u00adci\u00admen\u00adto')
          : type;
      const paceMarkup = paceParts.unit
        ? `<span class="fit-lap-pace-value">${escapeHtmlText(paceParts.value)}</span><span class="fit-lap-pace-unit">${escapeHtmlText(paceParts.unit)}</span>`
        : `<span class="fit-lap-pace-value">${escapeHtmlText(paceParts.value)}</span>`;
      tr.innerHTML = [
        `<td>${escapeHtmlText(String(lap.lap))}</td>`,
        `<td>${escapeHtmlText(displayType)}</td>`,
        `<td>${escapeHtmlText(displayDistance)}</td>`,
        `<td>${escapeHtmlText(duration)}</td>`,
        `<td class="fit-lap-pace">${paceMarkup}</td>`,
        `<td>${escapeHtmlText(String(hr))}</td>`,
        `<td>${escapeHtmlText(cadence)}</td>`,
        `<td>${escapeHtmlText(ascent)}</td>`,
      ].join('');
      fragment.appendChild(tr);
    }
    fitLapsBody.innerHTML = '';
    fitLapsBody.appendChild(fragment);
  };

  const renderFitData = () => {
    const source = resolveResultSource(training, fitData);
    if (!fitData || source === 'none') {
      fitDataSection.hidden = true;
      resultSourceBadge.hidden = true;
      resultSourceBadge.textContent = '';
      fitLapsSection.hidden = true;
      fitLapsBody.innerHTML = '';
      return;
    }
    fitDataSection.hidden = false;
    document.getElementById('fitDuration').textContent = fitData.fit_duration || '-';
    const distanceUnit = getUserPreferences().distance_unit;
    document.getElementById('fitDistance').textContent =
      fitData.fit_distance != null ? formatDistance(fitData.fit_distance, distanceUnit) : '-';
    document.getElementById('fitAvgPace').textContent =
      fitData.fit_avg_pace ? formatPaceFromMetric(fitData.fit_avg_pace, distanceUnit) : '-';
    document.getElementById('fitAvgHr').textContent = fitData.fit_avg_hr ?? '-';
    document.getElementById('fitMaxHr').textContent = fitData.fit_max_hr ?? '-';
    document.getElementById('fitElevation').textContent =
      fitData.fit_elevation_gain != null ? `${fitData.fit_elevation_gain} m` : '-';
    document.getElementById('fitCalories').textContent = fitData.fit_calories ?? '-';
    const badgeKey = resultSourceBadgeKey(source);
    resultSourceBadge.hidden = badgeKey === null;
    resultSourceBadge.textContent = badgeKey ? t(badgeKey) : '';
    renderLapsTable();
  };

  let feedbackShoes = [];
  let shoeOptionsLoaded = false;
  let shoeSelectionChanged = false;
  const renderFeedbackShoes = () => {
    if (!shoeOptionsLoaded) return;
    const selectedOption = shoeSelect.selectedOptions[0];
    const selectedValue = shoeSelect.value;
    const selectedLegacyLabel = selectedOption?.dataset.legacyLabel === 'true';
    shoeSelect.innerHTML = '<option value="">–</option>';
    const selectable = selectableFeedbackShoes(feedbackShoes, training.feedback_shoe_id);
    for (const shoe of selectable) {
      const option = document.createElement('option');
      const label = shoe.brand && shoe.model ? `${shoe.brand} ${shoe.model}` : shoe.model || shoe.brand || shoe.id;
      option.value = shoe.id;
      option.textContent = shoe.status === 'retired' ? `${label} (${t('shoes.status.retired')})` : label;
      option.disabled = shoe.status === 'retired';
      shoeSelect.appendChild(option);
    }
    if (training.feedback_shoe_id && !selectable.some((shoe) => shoe.id === training.feedback_shoe_id)) {
      const persisted = document.createElement('option');
      persisted.value = training.feedback_shoe_id;
      persisted.textContent = training.feedback_shoe || training.feedback_shoe_id;
      persisted.disabled = true;
      persisted.selected = true;
      shoeSelect.appendChild(persisted);
    }
    if (!training.feedback_shoe_id && training.feedback_shoe) {
      const legacy = document.createElement('option');
      legacy.value = '';
      legacy.textContent = training.feedback_shoe;
      legacy.disabled = true;
      legacy.dataset.legacyLabel = 'true';
      legacy.selected = selectedLegacyLabel || (!shoeSelectionChanged && !selectedValue && !training.feedback_shoe_id);
      shoeSelect.appendChild(legacy);
    }
    if (selectedLegacyLabel && shoeSelect.querySelector('option[data-legacy-label="true"]')) {
      shoeSelect.querySelector('option[data-legacy-label="true"]').selected = true;
    } else if (selectedValue && [...shoeSelect.options].some((option) => option.value === selectedValue)) {
      shoeSelect.value = selectedValue;
    } else if (training.feedback_shoe_id) {
      shoeSelect.value = training.feedback_shoe_id;
    }
  };
  const loadShoes = async () => {
    feedbackShoes = await fetchShoes();
    shoeOptionsLoaded = true;
    renderFeedbackShoes();
  };
  shoeSelect.addEventListener('change', () => { shoeSelectionChanged = true; });

  // The pain description only exists when pain was reported; hiding it also
  // discards any typed text so stale descriptions never reach the payload.
  const syncPainVisibility = () => {
    const showDescription = hasPainSelect.value === 'yes';
    painDescriptionField.hidden = !showDescription;
    if (!showDescription) {
      painInput.value = '';
    }
  };
  hasPainSelect.addEventListener('change', syncPainVisibility);

  let weatherAutofilled = false;
  let lastWeatherResult = null;

  const renderWeatherAutofill = () => {
    if (weatherAutofilled && lastWeatherResult) {
      weatherInput.value = formatWeatherAutofill(
        lastWeatherResult,
        t,
        getUserPreferences().temperature_unit
      );
    }
  };

  const autoFillWeatherField = async () => {
    if (!shouldAutoFillWeather(training, weatherInput.value)) return;
    weatherSpinner.hidden = false;
    weatherInput.setAttribute('aria-busy', 'true');
    try {
      const result = await fetchWeather(training.location, training.dia);
      const text = formatWeatherAutofill(result, t, getUserPreferences().temperature_unit);
      if (text !== '') {
        weatherInput.value = text;
        weatherAutofilled = true;
        lastWeatherResult = result;
      }
    } finally {
      weatherSpinner.hidden = true;
      weatherInput.removeAttribute('aria-busy');
    }
  };

  const id = resolveSessionId(window.location.search);
  if (!id) {
    window.location.href = '/calendar.html';
    return;
  }

  await initShell();
  i18n = getShellI18n();
  const importGuidance = createImportGuidance({
    trigger: importHelpBtn,
    dialog: importHelpDialog,
    translate: t,
    onManual: () => {
      resultSourceSelect.value = 'manual';
      syncResultSourceVisibility();
      manualInputs.distance.focus();
    },
  });
  const workoutCreationGuidance = createWorkoutCreationGuidance({
    trigger: workoutCreationBtn,
    dialog: workoutCreationDialog,
    translate: t,
  });

  const renderLocalizedUi = () => {
    document.title = t('training.title');
    if (training) dateEl.textContent = formatDateLabel(training.dia, i18n.language);
    if (!saveBtn.disabled) saveBtn.textContent = t('session.save');
    if (!generateBtn.disabled) generateLabel.textContent = t('session.generatePrompt');
    if (!copyPromptBtn.disabled) copyLabel.textContent = t('session.copyPrompt');
    renderFitDropzoneState();
    renderWeatherAutofill();
    renderFitData();
    renderFeedbackShoes();
    applyTooltips();
    importGuidance.render();
    workoutCreationGuidance.render();
    // A reported problem stays reported after the language switch, in the
    // language the user is now reading.
    if (rpeErrorKey) {
      rpeError.textContent = t(rpeErrorKey);
      setStatus(t(rpeErrorKey), 'error');
    }
  };

  document.addEventListener('app:languagechange', renderLocalizedUi);
  renderLocalizedUi();
  // The shell may have injected sidebar/topbar markup around the session
  // card; re-initializing Lucide ensures the card's trash icon is rendered
  // as an SVG and never left as an empty <i> tag.
  refreshIcons();

  setStatus(t('session.loading'));
  try {
    training = await fetchTraining(id);
  } catch {
    setStatus(t('session.errors.load'), 'error');
    return;
  }
  if (!training) {
    setStatus(t('session.errors.notFound'), 'error');
    return;
  }

  currentTrainingId = id;

  await loadShoes();

  dateEl.textContent = formatDateLabel(training.dia, i18n.language);
  for (const [field, elementId] of PLANNED_FIELDS) {
    document.getElementById(elementId).textContent = plannedValue(training, field);
  }

  const savedRpe = training.feedback_rpe;
  if (savedRpe != null) {
    const savedRadio = rpeSelector.querySelector(`input[type="radio"][value="${savedRpe}"]`);
    if (savedRadio) savedRadio.checked = true;
  }
  notesInput.value = training.feedback_notas ?? '';
  if (training.feedback_shoe_id) shoeSelect.value = training.feedback_shoe_id;
  weatherInput.value = training.feedback_weather ?? '';
  terrainInput.value = training.feedback_terrain ?? '';
  breathingInput.value = training.feedback_breathing ?? '';
  muscleInput.value = training.feedback_muscle ?? '';
  energyInput.value = training.feedback_energy ?? '';
  // Legacy rows only carry a description: any saved text implies "yes".
  const savedHasPain =
    training.feedback_has_pain === 'yes' ||
    (training.feedback_has_pain === null && Boolean(training.feedback_pain));
  hasPainSelect.value = savedHasPain ? 'yes' : 'no';
  painInput.value = training.feedback_pain ?? '';
  resultSourceSelect.value = training.result_data_source === 'manual' ? 'manual' : 'fit';
  hrSourceSelect.value = training.feedback_hr_source ?? '';

  if (training.fit_duration && training.result_data_source !== 'none') {
    let laps = [];
    if (training.fit_summary_json) {
      try {
        const parsed = JSON.parse(training.fit_summary_json);
        laps = Array.isArray(parsed.laps) ? parsed.laps : [];
      } catch { /* ignore malformed JSON */ }
    }
    fitData = {
      fit_duration: training.fit_duration,
      fit_distance: training.fit_distance,
      fit_avg_pace: training.fit_avg_pace,
      fit_avg_hr: training.fit_avg_hr,
      fit_max_hr: training.fit_max_hr,
      fit_elevation_gain: training.fit_elevation_gain,
      fit_calories: training.fit_calories,
      result_data_source: training.result_data_source,
      laps,
    };
    renderFitData();
  }

  if (training.result_data_source === 'manual') {
    const seconds = String(training.fit_duration ?? '0:0').split(':').map(Number);
    const total = seconds.reduce((sum, value) => sum * 60 + (Number.isFinite(value) ? value : 0), 0);
    const distanceUnit = getUserPreferences().distance_unit;
    manualInputs.distance.value = distanceUnit === 'mi'
      ? (Number(training.fit_distance ?? 0) * KM_TO_MILES).toFixed(2)
      : training.fit_distance ?? '';
    manualInputs.hours.value = Math.floor(total / 3600) || '';
    manualInputs.minutes.value = Math.floor((total % 3600) / 60) || '';
    manualInputs.seconds.value = total % 60 || '';
    manualInputs.avg_hr.value = training.fit_avg_hr ?? '';
    manualInputs.max_hr.value = training.fit_max_hr ?? '';
    manualInputs.elevation_gain_m.value = training.fit_elevation_gain ?? '';
    manualInputs.calories.value = training.fit_calories ?? '';
  }

  syncResultSourceVisibility();
  renderManualDistanceUnit();
  syncPainVisibility();
  await autoFillWeatherField();
  setStatus('');
  renderLocalizedUi();

  const collectFormState = () => {
    const hrValue = hrSourceSelect.value;
    const hrKey = HR_SOURCE_LABEL_KEYS[hrValue];
    const terrainKey = TERRAIN_LABEL_KEYS[terrainInput.value];
    const breathingKey = BREATHING_LABEL_KEYS[breathingInput.value];
    const muscleKey = MUSCLE_LABEL_KEYS[muscleInput.value];
    const energyKey = ENERGY_LABEL_KEYS[energyInput.value];
    const hasPainValue = hasPainSelect.value;
    const state = {
      feedback_rpe: normalizeFeedbackRpe(rpeSelector.querySelector('input[type="radio"]:checked')?.value ?? ''),
      feedback_notas: notesInput.value,
      feedback_shoe: shoeSelect.selectedOptions[0]?.textContent === '–'
        ? ''
        : shoeSelect.selectedOptions[0]?.textContent ?? training.feedback_shoe ?? '',
      feedback_hr_source: hrValue === '' ? null : hrValue,
      feedback_weather: weatherInput.value,
      feedback_terrain: terrainInput.value === '' ? null : terrainInput.value,
      feedback_breathing:
        breathingInput.value === '' ? null : breathingInput.value,
      feedback_muscle: muscleInput.value === '' ? null : muscleInput.value,
      feedback_energy: energyInput.value === '' ? null : energyInput.value,
      feedback_has_pain: hasPainValue === 'yes' ? 'yes' : 'no',
      feedback_pain: hasPainValue === 'yes' ? painInput.value : '',
      hr_source_label: hrKey ? t(hrKey) : '',
      terrain_label: terrainKey ? t(terrainKey) : '',
      breathing_label: breathingKey ? t(breathingKey) : '',
      muscle_label: muscleKey ? t(muscleKey) : '',
      energy_label: energyKey ? t(energyKey) : '',
      pain_description: painPromptText(hasPainValue, painInput.value, t),
      language: i18n.language,
      fitAttached: Boolean(fitFileInput.files && fitFileInput.files.length > 0),
    };
    if (shoeSelectionChanged) state.feedback_shoe_id = shoeSelect.value || null;
    return state;
  };

  const manualInputValues = () => Object.fromEntries(
    Object.entries(manualInputs).map(([key, input]) => [key, input.value])
  );
  const applyManualResults = (response) => {
    training = response.training;
    fitData = { ...training, laps: [] };
    resultSourceSelect.value = 'manual';
    renderFitData();
  };
  const persistManualResults = (feedbackRpe) => persistManualResultsIfNeeded({
    selectedSource: resultSourceSelect.value,
    values: manualInputValues(),
    distanceUnit: getUserPreferences().distance_unit,
    feedbackRpe,
    training,
    save: (payload) => saveManualTrainingResults(id, payload),
    confirmReplaceFit: () => showConfirm({
      title: t('session.replaceFitTitle'), message: t('session.replaceFitMessage'), icon: 'triangle-alert',
      confirmLabel: t('session.replaceConfirm'), cancelLabel: t('shell.confirm.no'),
    }),
    applyResponse: applyManualResults,
  });
  const applyCanonicalTraining = (canonical) => {
    const laps = canonical.result_data_source === 'fit_upload' ? (fitData?.laps || []) : [];
    training = canonical;
    fitData = { ...canonical, laps };
    resultSourceSelect.value = canonical.result_data_source === 'manual' ? 'manual' : 'fit';
    renderFitData();
  };
  const feedbackPayload = (state) => {
    const {
      feedback_shoe,
      hr_source_label,
      terrain_label,
      breathing_label,
      muscle_label,
      energy_label,
      pain_description,
      language,
      fitAttached,
      ...payload
    } = state;
    if (training.result_data_source === 'manual' || training.result_data_source === 'fit_upload') {
      payload.completed = true;
    }
    return payload;
  };
  const persistCurrentState = (rpe) => persistCurrentTrainingState({
    collectState: () => {
      const state = collectFormState();
      return isAnsweredFeedbackRpe(state.feedback_rpe)
        ? { payload: feedbackPayload(state) }
        : { status: 'invalid', error: 'rpe' };
    },
    persistManual: () => persistManualResults(rpe),
    saveFeedback: (payload) => saveTrainingFeedback(id, payload),
    applyTraining: applyCanonicalTraining,
  });
  const reportPersistenceFailure = (result) => {
    if (result.status === 'invalid') {
      setStatus(result.error === 'rpe' ? t('session.errors.rpe') : t('session.errors.manualValidation'), 'error');
    }
    if (result.status === 'error') {
      setStatus(result.stage === 'feedback' ? t('session.errors.save') : result.error?.message || t('session.errors.manualSave'), 'error');
    }
  };

  saveBtn.addEventListener('click', async () => {
    // No answered RPE means no manual write, no feedback write and no
    // navigation: the form keeps every value and only the group reports why.
    const rpe = requireFeedbackRpe();
    if (rpe === null) return;
    saveBtn.disabled = true;
    generateBtn.disabled = true;
    saveBtn.textContent = t('session.saving');
    try {
      const result = await persistCurrentState(rpe);
      if (result.status === 'invalid' || result.status === 'cancelled' || result.status === 'error') {
        reportPersistenceFailure(result);
        return;
      }
      window.location.href = '/calendar.html';
    } catch {
      setStatus(t('session.errors.save'), 'error');
    } finally {
      saveBtn.disabled = false;
      generateBtn.disabled = false;
      saveBtn.textContent = t('session.save');
    }
  });

  generateBtn.addEventListener('click', async () => {
    // The prompt describes a realized effort, so it is only produced after the
    // same required RPE the save action enforces.
    const rpe = requireFeedbackRpe();
    if (rpe === null) return;
    generateBtn.disabled = true;
    saveBtn.disabled = true;
    generateLabel.textContent = t('session.generatingPrompt');
    try {
      const result = await persistCurrentState(rpe);
      if (result.status === 'invalid' || result.status === 'cancelled' || result.status === 'error') {
        reportPersistenceFailure(result);
        return;
      }
      promptText = buildAnalysisPrompt(
        templateFor(i18n.language),
        collectPromptValues({
          training,
          form: buildCanonicalPromptForm(training, {
            language: i18n.language,
            messages: i18n.messages,
            fitAttached: Boolean(fitFileInput.files && fitFileInput.files.length > 0),
          }),
          fitData,
          preferences: getUserPreferences(),
          messages: i18n.messages,
        })
      );
      promptOutput.value = promptText;
      promptSection.hidden = false;
    } finally {
      generateBtn.disabled = false;
      saveBtn.disabled = false;
      generateLabel.textContent = t('session.generatePrompt');
    }
  });

  copyPromptBtn.addEventListener('click', async () => {
    const copied = await copyAnalysisPrompt(promptText);
    copyLabel.textContent = copied ? t('session.copied') : t('session.copyPrompt');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copyLabel.textContent = t('session.copyPrompt');
    }, 2000);
  });

  deleteTrainingBtn.addEventListener('click', () => {
    handleTrainingDelete({
      id,
      messages: i18n.messages,
      confirm: showConfirm,
      remove: deleteTraining,
      toast: showShellToast,
    });
  });

  fitFileInput.addEventListener('change', async () => {
    if (!fitFileInput.files || fitFileInput.files.length === 0 || !currentTrainingId) return;
    const file = fitFileInput.files[0];
    if (!/\.(fit|zip)$/i.test(file.name)) {
      setStatus(t('session.fitUnsupported'), 'error');
      fitFileInput.value = '';
      renderFitDropzoneState();
      return;
    }
    // The upload itself concludes the workout, so it waits for the reported
    // effort: no confirmation dialog, no request and no pending file state
    // while the required choice is missing.
    const rpe = requireFeedbackRpe();
    if (rpe === null) {
      fitFileInput.value = '';
      renderFitDropzoneState();
      return;
    }
    if (training.result_data_source === 'manual') {
      const confirmed = await showConfirm({
        title: t('session.replaceManualTitle'), message: t('session.replaceManualMessage'), icon: 'triangle-alert',
        confirmLabel: t('session.replaceConfirm'), cancelLabel: t('shell.confirm.no'),
      });
      if (!confirmed) {
        fitFileInput.value = '';
        renderFitDropzoneState();
        return;
      }
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('feedback_rpe', String(rpe));
    if (training.result_data_source === 'manual') formData.append('confirm_replace_manual', 'true');
    try {
      const response = await fetch(`/api/trainings/${currentTrainingId}/fit`, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.code ? fitUploadErrorMessage(payload.code, t) : t('session.errors.fitUpload'));
      }
      const result = await response.json();
      fitData = {
        fit_duration: result.fit_duration,
        fit_distance: result.fit_distance,
        fit_avg_pace: result.fit_avg_pace,
        fit_avg_hr: result.fit_avg_hr,
        fit_max_hr: result.fit_max_hr,
        fit_elevation_gain: result.fit_elevation_gain,
        fit_calories: result.fit_calories,
        result_data_source: result.result_data_source,
        laps: result.laps || [],
      };
      training = { ...training, ...fitData, feedback_rpe: rpe };
      renderFitData();
    } catch (error) {
      setStatus(error.message || t('session.errors.fitUpload'), 'error');
    }
  });

  document.addEventListener('kinesis:preferences-changed', () => {
    renderFitData();
    renderWeatherAutofill();
    renderManualDistanceUnit({ convertExisting: true });
  });
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initTrainingResult();
}
