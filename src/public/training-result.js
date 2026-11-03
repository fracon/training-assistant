import {
  HR_SOURCE_LABEL_KEYS,
  TERRAIN_LABEL_KEYS,
  BREATHING_LABEL_KEYS,
  MUSCLE_LABEL_KEYS,
  ENERGY_LABEL_KEYS,
  formatDateLabel,
  resolveResultSource,
  formatCadence,
  splitPaceLabel,
  formatLapType,
} from './shared/analysis-prompts.js';
import { initShell, getShellI18n, getUserPreferences, showConfirm, showShellToast, refreshIcons } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate as formatLocalizedDate, formatWeekday } from './shared/date.js';
import { fetchTraining, saveTrainingFeedback, saveManualTrainingResults, fetchShoes, deleteTraining, fetchWeather, startAiExecution, fetchAiExecution, fetchAiExecutions, fetchWorkoutAnalyses, updateAiInterpretation, previewAnalysisPrompt } from './shared/api.js';
import { createDialogFocusTrap } from './shared/dialog-focus.js';
import { createExternalPromptModal } from './shared/external-prompt-modal.js';
import { KM_TO_MILES, convertDistanceInputValue, convertDistanceToKm, formatDistance, formatPaceFromMetric, formatTemperature } from './shared/units.js';
import { createImportGuidance } from './shared/workout-import-guidance.js';
import { createWorkoutCreationGuidance } from './shared/workout-creation-guidance.js';
import { summarizePrescription } from './shared/weekly-prescription-display.js';
import { parseWorkoutDurationInput } from './shared/duration-input.mjs';

export { HR_SOURCE_LABEL_KEYS, TERRAIN_LABEL_KEYS, BREATHING_LABEL_KEYS,
  MUSCLE_LABEL_KEYS, ENERGY_LABEL_KEYS, formatDateLabel, resolveResultSource,
  weekdayLabel, formatCadence, splitPaceLabel, formatLapType, buildLapsMarkdown } from './shared/analysis-prompts.js';

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
  if (source === 'garmin_connect') return 'session.sourceGarminBadge';
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
  confirmReplaceGarmin = async () => false,
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
  if (training.result_data_source === 'garmin_connect') {
    const confirmed = await confirmReplaceGarmin();
    if (!confirmed) return { status: 'cancelled' };
    payload.confirm_replace_garmin = true;
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
  activity_evidence_conflict: 'session.garminImport.activity_evidence_conflict',
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

const ANALYSIS_POLL_MS = 1800;
const ANALYSIS_RETRY_MAX_MS = 30000;
const ANALYSIS_TERMINAL = new Set(['completed', 'failed', 'uncertain', 'cancelled', 'outdated']);
function appendAnalysisClaim(parent, heading, claim) {
  const section = document.createElement('section');
  section.className = 'analysis-copy-section';
  const title = document.createElement('h3');
  title.textContent = heading;
  const text = document.createElement('p');
  text.textContent = claim.text;
  section.append(title, text);
  parent.append(section);
}
function appendAnalysisList(parent, heading, items) {
  if (!items?.length) return;
  const section = document.createElement('section');
  section.className = 'analysis-copy-section';
  const title = document.createElement('h3');
  title.textContent = heading;
  const list = document.createElement('ul');
  for (const item of items) {
    const line = document.createElement('li');
    line.textContent = item.text;
    list.append(line);
  }
  section.append(title, list);
  parent.append(section);
}
export function renderWorkoutAnalysis(parent, result, labels) {
  parent.replaceChildren();
  if (!result) return;
  appendAnalysisClaim(parent, labels.summary, result.summary);
  const classification = document.createElement('p');
  classification.className = 'analysis-classification';
  classification.textContent = `${labels.classification}: ${labels.classifications[result.classification.value] || labels.classifications.insufficient_data}`;
  parent.append(classification);
  appendAnalysisClaim(parent, labels.comparison, result.comparison);
  appendAnalysisList(parent, labels.contextualReading, result.contextualReading);
  appendAnalysisList(parent, labels.attention, result.attention);
  appendAnalysisList(parent, labels.recommendations, result.recommendations);
  appendAnalysisList(parent, labels.limitations, result.limitations.map((text) => ({ text })));
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
  const feedbackAccordionTrigger = document.getElementById('feedbackAccordionTrigger');
  const feedbackAccordionPanel = document.getElementById('feedbackAccordionPanel');
  const garminAccordionTrigger = document.getElementById('garminAccordionTrigger');
  const garminAccordionPanel = document.getElementById('garminAccordionPanel');
  const setAccordionOpen = (trigger, panel, open) => {
    const expanded = Boolean(open);
    if (trigger.getAttribute('aria-expanded') === String(expanded)) return;
    if (!expanded && panel.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    trigger.setAttribute('aria-expanded', String(expanded));
    panel.hidden = !expanded;
  };
  const focusInAccordion = (trigger, panel, target) => {
    setAccordionOpen(trigger, panel, true);
    requestAnimationFrame(() => {
      if (trigger.getAttribute('aria-expanded') !== 'true' || panel.hidden || !target?.isConnected) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    });
  };
  const wireAccordion = (trigger, panel) => {
    trigger.addEventListener('click', () => setAccordionOpen(trigger, panel, trigger.getAttribute('aria-expanded') !== 'true'));
  };
  wireAccordion(feedbackAccordionTrigger, feedbackAccordionPanel);
  wireAccordion(garminAccordionTrigger, garminAccordionPanel);
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    setAccordionOpen(garminAccordionTrigger, garminAccordionPanel, false);
    setAccordionOpen(feedbackAccordionTrigger, feedbackAccordionPanel, false);
  });
  const dateEl = document.getElementById('sessionDate');
  const saveBtn = document.getElementById('saveBtn');
  const rpeSelector = document.getElementById('feedbackRpe');
  const rpeError = document.getElementById('feedbackRpeError');
  const notesInput = document.getElementById('feedbackNotas');
  const resultSourceSelect = document.getElementById('resultSourceSelect');
  const fitField = document.getElementById('fitField');
  const garminActivityField = document.getElementById('garminActivityField');
  const garminActivitySwitch = document.getElementById('garminActivitySwitch');
  const garminActivitySearch = document.getElementById('garminActivitySearch');
  const garminActivityRefresh = document.getElementById('garminActivityRefresh');
  const garminActivityMore = document.getElementById('garminActivityMore');
  const garminActivityStatus = document.getElementById('garminActivityStatus');
  const garminActivityCandidates = document.getElementById('garminActivityCandidates');
  const garminActivityPreview = document.getElementById('garminActivityPreview');
  const garminActivityPreviewHeading = document.getElementById('garminActivityPreviewHeading');
  const garminActivityPreviewName = document.getElementById('garminActivityPreviewName');
  const garminActivityPreviewContext = document.getElementById('garminActivityPreviewContext');
  const garminActivityReplaceNotice = document.getElementById('garminActivityReplaceNotice');
  const garminActivityPreviewData = document.getElementById('garminActivityPreviewData');
  const garminActivityConfirm = document.getElementById('garminActivityConfirm');
  const garminActivityBack = document.getElementById('garminActivityBack');
  const garminActivityWindow = document.getElementById('garminActivityWindow');
  const garminActivityGuidance = document.getElementById('garminActivityGuidance');
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
  const analysisSection = document.getElementById('analysisSection');
  const formActions = document.querySelector('#feedbackAccordionPanel > .form-actions');
  const analysisLoadWarning = document.getElementById('analysisLoadWarning');
  const analysisLoadMessage = document.getElementById('analysisLoadMessage');
  const analysisLoadAgain = document.getElementById('analysisLoadAgain');
  const analysisState = document.getElementById('analysisState');
  const analysisNotice = document.getElementById('analysisNotice');
  const analysisContent = document.getElementById('analysisContent');
  const analysisHistory = document.getElementById('analysisHistory');
  const analysisHistoryContent = document.getElementById('analysisHistoryContent');
  const analysisReadAgain = document.createElement('button');
  analysisReadAgain.id = 'analysisReadAgain';
  analysisReadAgain.type = 'button';
  analysisReadAgain.className = 'btn-secondary btn-small';
  analysisReadAgain.hidden = true;
  analysisSection.querySelector('.analysis-header').append(analysisReadAgain);
  const correctionDialog = document.getElementById('analysisCorrectionDialog');
  const correctionText = document.getElementById('analysisCorrectionText');
  const correctionError = document.getElementById('analysisCorrectionError');
  const correctionSave = correctionDialog.querySelector('[data-analysis-correction-save]');
  const correctionTrap = createDialogFocusTrap(correctionDialog, () => closeCorrectionDialog());
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
  let fitData = null;
  let currentTrainingId = null;
  let training = null;
  let adminPrompt = null;
  let analysisData = null;
  let activeAnalysisId = null;
  let analysisReadToken = 0;
  let analysisReadTimer = null;
  let analysisReadController = null;
  let analysisReadInFlight = false;
  let analysisPendingRefresh = null;
  let analysisReadFailureCount = 0;
  let analysisPageActive = true;
  let analysisLoadErrorKey = 'analysisUnavailable';
  let analysisStartPending = false;
  let analysisOutcomeUncertain = false;
  let activeAnalysisRequestKey = null;
  let correctionTarget = null;
  let correctionReturnFocus = null;
  let correctionDialogRevision = 0;
  let correctionMutationPending = false;
  let manualDistanceInputUnit = 'km';
  let rpeErrorKey = null;
  let feedbackBaselineSignature = null;
  let feedbackPersistenceSnapshot = null;
  let feedbackProgressKey = null;
  const t = (key, params) => translate(i18n ? i18n.messages : {}, key, params);
  const feedbackSignature = ({ omitFile = false } = {}) => JSON.stringify([...feedbackAccordionPanel.querySelectorAll('input, select, textarea')]
    .map((field) => [
    field.id, field.type === 'file' ? '' : field.type === 'radio' || field.type === 'checkbox' ? field.checked : field.value,
    field.type === 'file' && !omitFile && field.files?.length
      ? [...field.files].map((file) => [file.name, file.size, file.lastModified]) : null,
    ]));
  const refreshFeedbackAccordionSummary = () => {
    const dirty = feedbackBaselineSignature !== null && feedbackSignature() !== feedbackBaselineSignature;
    let key = 'resultNotRecorded';
    if (feedbackProgressKey) key = feedbackProgressKey;
    else if (analysisStartPending || activeAnalysisId) key = 'analysisInProgress';
    else if (analysisOutcomeUncertain) key = 'analysisAwaitingConfirmation';
    else if (analysisNotice.dataset.key && !analysisNotice.hidden) key = 'analysisNeedsAttention';
    else if (dirty) key = 'unsavedChanges';
    else {
      const hasRpe = isAnsweredFeedbackRpe(training?.feedback_rpe);
      if (training?.result_data_source === 'fit_upload') key = hasRpe ? 'fitFeedbackSaved' : 'fitFeedbackPending';
      else if (training?.result_data_source === 'garmin_connect') key = hasRpe ? 'garminFeedbackSaved' : 'garminFeedbackPending';
      else if (training?.result_data_source === 'manual') key = hasRpe ? 'manualFeedbackSaved' : 'manualFeedbackPending';
      else if (hasRpe) key = 'feedbackSavedResultPending';
    }
    const summary = document.getElementById('feedbackAccordionSummary');
    const text = t(`session.accordion.${key}`);
    if (summary.textContent !== text) summary.textContent = text;
  };
  feedbackAccordionPanel.addEventListener('input', refreshFeedbackAccordionSummary);
  feedbackAccordionPanel.addEventListener('change', refreshFeedbackAccordionSummary);
  document.addEventListener('app:languagechange', refreshFeedbackAccordionSummary);
  const setFeedbackProgress = (key) => {
    feedbackProgressKey = key || null;
    refreshFeedbackAccordionSummary();
  };
  const analysisLabels = () => ({
    summary: t('session.analysis.summary'), comparison: t('session.analysis.comparison'),
    contextualReading: t('session.analysis.contextualReading'), attention: t('session.analysis.attention'),
    recommendations: t('session.analysis.recommendations'), limitations: t('session.analysis.limitations'),
    classification: t('session.analysis.classification'),
    classifications: {
      below_expectations: t('session.analysis.classifications.below'),
      adequate: t('session.analysis.classifications.adequate'), good: t('session.analysis.classifications.good'),
      very_good: t('session.analysis.classifications.veryGood'), excellent: t('session.analysis.classifications.excellent'),
      insufficient_data: t('session.analysis.classifications.insufficient'),
    },
  });
  const analysisKey = (key) => t(`session.analysis.${key}`);
  const interpretationErrorKey = (error) => error?.status === 409
    ? 'interpretationConflict'
    : error?.codes?.includes('incompatibleRpeScale')
      ? 'errors.incompatibleRpeScale' : 'interpretationSaveError';
  const clearAnalysisTimer = () => { clearTimeout(analysisReadTimer); analysisReadTimer = null; };
  const analysisStorageKey = () => `kinesis:analysis-request:${currentTrainingId}`;
  const renderInterpretations = (parent, items) => {
    if (!items?.length) return;
    const section = document.createElement('section');
    section.className = 'analysis-interpretations';
    const heading = document.createElement('h3');
    heading.textContent = analysisKey('interpretations');
    section.append(heading);
    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'analysis-interpretation';
      card.dataset.interpretationId = item.id;
      card.tabIndex = -1;
      const title = document.createElement('h4');
      title.textContent = analysisKey(`dispositions.${item.disposition}`);
      const text = document.createElement('p');
      text.textContent = item.correction || item.text;
      card.append(title, text);
      if (['pending', 'confirmed', 'corrected'].includes(item.disposition)) {
        const actions = document.createElement('div');
        actions.className = 'analysis-item-actions';
        if (item.disposition === 'pending') {
          const confirm = document.createElement('button');
          confirm.className = 'btn-secondary btn-small';
          confirm.type = 'button';
          confirm.textContent = analysisKey('confirm');
          confirm.dataset.interpretationAction = `${item.id}:correct`;
          confirm.addEventListener('click', () => void mutateInterpretation(item, 'confirm'));
          actions.append(confirm);
        }
        const correct = document.createElement('button');
        correct.className = 'btn-secondary btn-small';
        correct.type = 'button';
        correct.textContent = analysisKey('correct');
        correct.dataset.interpretationAction = `${item.id}:correct`;
        correct.addEventListener('click', () => openCorrectionDialog(item, correct));
        const discard = document.createElement('button');
        discard.className = 'btn-secondary btn-small';
        discard.type = 'button';
        discard.textContent = analysisKey('discard');
        discard.dataset.interpretationAction = `${item.id}:discard`;
        discard.addEventListener('click', () => void mutateInterpretation(item, 'discard'));
        actions.append(correct, discard);
        card.append(actions);
      }
      section.append(card);
    }
    parent.append(section);
  };
  const renderAnalysisVersion = (parent, version) => {
    const card = document.createElement('article');
    card.className = 'analysis-version';
    if (version.outdated) {
      const stale = document.createElement('p');
      stale.className = 'analysis-stale';
      stale.textContent = analysisKey('outdated');
      card.append(stale);
    }
    const content = document.createElement('div');
    content.className = 'analysis-version-content';
    renderWorkoutAnalysis(content, version.result, analysisLabels());
    card.append(content);
    renderInterpretations(card, version.interpretations);
    parent.append(card);
  };
  const renderAnalysis = () => {
    const data = analysisData;
    const last = data?.analyses?.[0] || null;
    const latest = data?.latest || null;
    analysisSection.hidden = !(data?.analyses?.length || data?.active || activeAnalysisId || analysisStartPending || analysisOutcomeUncertain || analysisNotice.dataset.key);
    generateBtn.disabled = Boolean(activeAnalysisId || analysisStartPending || analysisOutcomeUncertain);
    analysisContent.replaceChildren();
    analysisHistoryContent.replaceChildren();
    analysisHistory.hidden = !data?.analyses?.some((item) => item.result && item.id !== latest?.id);
    if (data?.active || activeAnalysisId) {
      analysisState.textContent = analysisKey('running');
    } else if (analysisOutcomeUncertain) {
      analysisState.textContent = analysisKey('recovering');
    } else if (last && last.state !== 'completed') {
      analysisState.textContent = analysisKey(`states.${last.state}`) || analysisKey('states.failed');
      if (!analysisNotice.dataset.key && (last.state === 'failed' || last.state === 'uncertain' || last.state === 'cancelled' || last.state === 'outdated')) {
        analysisNotice.hidden = false;
        analysisNotice.dataset.key = `errors.${last.errorCode || last.state}`;
        analysisNotice.textContent = analysisKey(analysisNotice.dataset.key);
      }
    } else {
      analysisState.textContent = '';
    }
    if (latest) renderAnalysisVersion(analysisContent, latest);
    for (const old of data?.analyses?.filter((item) => item.result && item.id !== latest?.id) || []) {
      const details = document.createElement('details');
      details.className = 'analysis-history-item';
      const summary = document.createElement('summary');
      summary.textContent = `${analysisKey('version')} ${old.sequence} · ${formatLocalizedDate(old.createdAt.slice(0, 10), i18n.language)}`;
      details.append(summary);
      renderAnalysisVersion(details, old);
      analysisHistoryContent.append(details);
    }
    analysisReadAgain.hidden = !(analysisNotice.dataset.retry === 'true');
    analysisReadAgain.textContent = analysisKey('readAgain');
    refreshFeedbackAccordionSummary();
  };
  const setAnalysisNotice = (key, retry = false) => {
    analysisNotice.hidden = !key;
    analysisNotice.dataset.key = key || '';
    analysisNotice.textContent = key ? analysisKey(key) : '';
    analysisNotice.dataset.retry = retry ? 'true' : 'false';
    renderAnalysis();
  };
  const definitiveAnalysisReadError = (error) => [401, 403, 404].includes(error?.status) ||
    error?.codes?.some((code) => ['authenticationRequired', 'executionNotFound', 'resourceNotFound'].includes(code));
  const analysisBackoff = () => {
    analysisReadFailureCount += 1;
    const base = Math.min(ANALYSIS_RETRY_MAX_MS, ANALYSIS_POLL_MS * 2 ** Math.min(analysisReadFailureCount - 1, 5));
    return Math.round(Math.min(ANALYSIS_RETRY_MAX_MS, Math.max(900, base * (0.5 + Math.random()))));
  };
  const scheduleAnalysisRead = (id, token, delay) => {
    clearAnalysisTimer();
    analysisReadTimer = setTimeout(() => {
      analysisReadTimer = null;
      void refreshAnalysisExecution(id, token);
    }, delay);
  };
  async function refreshAnalysisExecution(id, token = analysisReadToken) {
    if (!analysisPageActive || token !== analysisReadToken || activeAnalysisId !== id) return;
    if (analysisReadInFlight) { analysisPendingRefresh = { id, token }; return; }
    analysisReadInFlight = true;
    const controller = new AbortController();
    analysisReadController = controller;
    try {
      const execution = await fetchAiExecution(id, { signal: controller.signal });
      if (token !== analysisReadToken || activeAnalysisId !== id) return;
      if (!['queued', 'running', ...ANALYSIS_TERMINAL].includes(execution.state)) throw new Error('invalid-state');
      if (execution.state === 'queued' || execution.state === 'running') {
        analysisReadFailureCount = 0;
        setAnalysisNotice('', false);
        scheduleAnalysisRead(id, token, ANALYSIS_POLL_MS);
        return;
      }
      clearAnalysisTimer();
      const data = await fetchWorkoutAnalyses(currentTrainingId, { signal: controller.signal });
      if (token !== analysisReadToken || activeAnalysisId !== id) return;
      activeAnalysisId = null;
      analysisData = data;
      analysisReadFailureCount = 0;
      analysisOutcomeUncertain = false;
      activeAnalysisRequestKey = null;
      try { sessionStorage.removeItem(analysisStorageKey()); } catch { /* storage unavailable */ }
      setAnalysisNotice('', false);
    } catch (error) {
      if (error?.name === 'AbortError' || token !== analysisReadToken || activeAnalysisId !== id) return;
      if (definitiveAnalysisReadError(error)) {
        activeAnalysisId = null;
        analysisOutcomeUncertain = true;
        setAnalysisNotice('readUnavailable', true);
      } else {
        setAnalysisNotice('connectionRetrying', false);
        scheduleAnalysisRead(id, token, analysisBackoff());
      }
    } finally {
      if (analysisReadController === controller) analysisReadController = null;
      analysisReadInFlight = false;
      if (analysisPendingRefresh) {
        const next = analysisPendingRefresh;
        analysisPendingRefresh = null;
        queueMicrotask(() => void refreshAnalysisExecution(next.id, next.token));
      }
    }
  }
  async function loadAnalysisState() {
    const token = ++analysisReadToken;
    clearAnalysisTimer();
    let loaded;
    try {
      loaded = await fetchWorkoutAnalyses(currentTrainingId);
    } catch {
      if (token !== analysisReadToken) return false;
      analysisLoadErrorKey = 'analysisUnavailable';
      analysisLoadMessage.textContent = analysisKey(analysisLoadErrorKey);
      analysisLoadWarning.hidden = false;
      analysisLoadAgain.disabled = false;
      if (!analysisData?.analyses?.length && !analysisData?.active) analysisSection.hidden = true;
      return false;
    }
    if (token !== analysisReadToken) return false;
    if (!loaded || !Array.isArray(loaded.analyses)) {
      analysisLoadErrorKey = 'analysisUnavailable';
      analysisLoadMessage.textContent = analysisKey(analysisLoadErrorKey);
      analysisLoadWarning.hidden = false;
      analysisLoadAgain.disabled = false;
      if (!analysisData?.analyses?.length && !analysisData?.active) analysisSection.hidden = true;
      return false;
    }
    analysisData = loaded;
    activeAnalysisId = analysisData.active?.id ?? null;
    analysisOutcomeUncertain = false;
    analysisLoadWarning.hidden = true;
    analysisLoadErrorKey = 'analysisUnavailable';
    analysisLoadAgain.disabled = false;
    try {
      setAnalysisNotice('', false);
      renderAnalysis();
    } catch {
      analysisLoadErrorKey = 'analysisDisplayUnavailable';
      analysisLoadMessage.textContent = analysisKey(analysisLoadErrorKey);
      analysisLoadWarning.hidden = false;
      return false;
    }
    if (analysisData.active) {
      void refreshAnalysisExecution(activeAnalysisId, token);
      return true;
    }
    const pendingKey = activeAnalysisRequestKey || (() => { try { return sessionStorage.getItem(analysisStorageKey()); } catch { return null; } })();
    if (pendingKey) {
      activeAnalysisRequestKey = pendingKey;
      analysisOutcomeUncertain = true;
      renderAnalysis();
      let executions;
      try {
        executions = await fetchAiExecutions(pendingKey);
      } catch {
        if (token === analysisReadToken) setAnalysisNotice('recoveryUnavailable', true);
        return false;
      }
      if (token !== analysisReadToken) return false;
      const match = executions.find((item) => item.purpose === 'analysis' && String(item.resource_id) === String(currentTrainingId) && item.idempotency_key === pendingKey);
      if (match) {
        activeAnalysisId = match.id;
        analysisOutcomeUncertain = false;
        setAnalysisNotice('', false);
        void refreshAnalysisExecution(match.id, token);
      } else {
        activeAnalysisRequestKey = null;
        analysisOutcomeUncertain = false;
        try { sessionStorage.removeItem(analysisStorageKey()); } catch { /* storage unavailable */ }
        setAnalysisNotice('', false);
      }
      renderAnalysis();
    }
    return true;
  }
  async function mutateInterpretation(item, action, text, trigger = document.activeElement) {
    try {
      const saved = await updateAiInterpretation(item.id, action, item.version, text);
      const versions = [...(analysisData?.analyses || []), ...(analysisData?.latest ? [analysisData.latest] : [])];
      for (const version of versions) {
        const current = version.interpretations?.find((entry) => entry.id === item.id);
        if (current) Object.assign(current, saved.interpretation);
      }
      renderAnalysis();
      const refreshed = await loadAnalysisState();
      if (trigger?.isConnected === false && document.activeElement === document.body) {
        const equivalent = analysisContent.querySelector(`[data-interpretation-action="${item.id}:${action === 'confirm' ? 'correct' : action}"]`);
        const card = analysisContent.querySelector(`[data-interpretation-id="${item.id}"]`);
        (equivalent || card)?.focus();
      }
      return { saved: true, refreshed };
    } catch (error) {
      setAnalysisNotice(interpretationErrorKey(error), true);
      return { saved: false, error };
    }
  }
  function closeCorrectionDialog({ restore = true } = {}) {
    correctionDialogRevision += 1;
    correctionTrap.deactivate();
    correctionDialog.hidden = true;
    if (restore && correctionReturnFocus?.isConnected) correctionReturnFocus.focus();
    correctionTarget = null;
    correctionError.hidden = true;
    correctionError.textContent = '';
    correctionText.removeAttribute('aria-invalid');
    correctionText.removeAttribute('aria-describedby');
  }
  function openCorrectionDialog(item, trigger) {
    correctionDialogRevision += 1;
    correctionTarget = item;
    correctionReturnFocus = trigger;
    correctionText.value = item.correction || '';
    correctionError.hidden = true;
    correctionError.textContent = '';
    correctionText.removeAttribute('aria-invalid');
    correctionText.removeAttribute('aria-describedby');
    correctionSave.disabled = correctionMutationPending;
    correctionDialog.hidden = false;
    correctionTrap.activate();
    correctionDialog.querySelector('[data-analysis-correction-close]').focus();
    refreshIcons();
  }
  correctionDialog.querySelectorAll('[data-analysis-correction-close],[data-analysis-correction-cancel]').forEach((button) => button.addEventListener('click', closeCorrectionDialog));
  correctionSave.addEventListener('click', async () => {
    if (!correctionTarget || !correctionText.value.trim() || correctionMutationPending) return;
    const item = correctionTarget;
    const revision = correctionDialogRevision;
    correctionMutationPending = true;
    correctionSave.disabled = true;
    correctionError.hidden = true;
    const result = await mutateInterpretation(item, 'correct', correctionText.value.trim(), correctionReturnFocus);
    correctionMutationPending = false;
    if (correctionDialog.hidden) return;
    if (revision !== correctionDialogRevision || correctionTarget?.id !== item.id) {
      correctionSave.disabled = false;
      return;
    }
    correctionSave.disabled = false;
    if (!result.saved) {
      correctionError.textContent = analysisKey(interpretationErrorKey(result.error));
      correctionError.hidden = false;
      correctionText.setAttribute('aria-invalid', 'true');
      correctionText.setAttribute('aria-describedby', 'analysisCorrectionError');
      return;
    }
    correctionDialog.hidden = true;
    correctionTrap.deactivate();
    correctionTarget = null;
    correctionError.hidden = true;
    correctionError.textContent = '';
    correctionText.removeAttribute('aria-invalid');
    correctionText.removeAttribute('aria-describedby');
    const equivalent = analysisContent.querySelector(`[data-interpretation-action="${item.id}:correct"]`);
    const card = analysisContent.querySelector(`[data-interpretation-id="${item.id}"]`);
    (equivalent || card || generateBtn).focus();
  });
  analysisReadAgain.addEventListener('click', () => {
    if (activeAnalysisId) void refreshAnalysisExecution(activeAnalysisId, ++analysisReadToken);
    else void loadAnalysisState();
  });
  analysisLoadAgain.addEventListener('click', async () => {
    if (analysisLoadAgain.disabled) return;
    analysisLoadAgain.disabled = true;
    const shouldRestoreFocus = document.activeElement === analysisLoadAgain;
    const loaded = await loadAnalysisState();
    if (shouldRestoreFocus && loaded && analysisLoadWarning.hidden && document.activeElement === document.body)
      (analysisData?.latest ? document.getElementById('analysisTitle') : generateBtn).focus({ preventScroll: true });
  });

  const applyTooltips = () => {
    rpeSelector.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
  };

  const setStatus = (message, tone = '') => {
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  };
  const revealFeedbackError = () => focusInAccordion(feedbackAccordionTrigger, feedbackAccordionPanel, statusEl);

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
    focusInAccordion(feedbackAccordionTrigger, feedbackAccordionPanel, rpeSelector.querySelector('input[type="radio"]'));
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

  let garminActivitySelectionOpen = false;
  const hasCurrentGarminActivity = () => training?.result_data_source === 'garmin_connect'
    && training?.garmin_activity?.activity_id != null;
  const syncResultSourceVisibility = () => {
    const manual = resultSourceSelect.value === 'manual';
    const garmin = resultSourceSelect.value === 'garmin';
    const currentGarminActivity = hasCurrentGarminActivity();
    fitField.hidden = manual;
    fitField.hidden = manual || garmin;
    manualResultsField.hidden = !manual;
    garminActivityField.hidden = !garmin || (currentGarminActivity && !garminActivitySelectionOpen);
    garminActivityGuidance.hidden = currentGarminActivity;
    garminActivitySearch.hidden = currentGarminActivity || garminActivityHasSearched;
    garminActivitySwitch.hidden = !currentGarminActivity;
    garminActivitySwitch.textContent = t(garminActivitySelectionOpen
      ? 'session.garminImport.backToCurrentResult' : 'session.garminImport.switchActivity');
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
  resultSourceSelect.addEventListener('change', () => {
    if (resultSourceSelect.value !== 'garmin') garminActivitySelectionOpen = false;
    syncResultSourceVisibility();
    if (resultSourceSelect.value === 'garmin') updateGarminActivityWindow();
    else if (garminActivityBusy && !garminActivityConfirm.hasAttribute('aria-busy')) {
      // A late search/download response must not repopulate a hidden source panel.
      garminActivityReadId += 1;
      garminActivityBusy = false;
      garminActivitySearch.disabled = false;
      garminActivityRefresh.disabled = false;
      garminActivityMore.disabled = false;
      garminActivityMore.textContent = t('session.garminImport.more');
      garminActivitySearch.removeAttribute('aria-busy');
      garminActivityMore.removeAttribute('aria-busy');
      garminActivityCandidates.removeAttribute('aria-busy');
      setGarminActivityStatus('');
      renderGarminActivityCandidates();
    }
  });

  let garminActivityCandidatesState = [];
  let garminActivityNextOffset = 0;
  let garminActivityPreviewId = null;
  let selectedGarminActivity = null;
  let garminActivityBusy = false;
  let garminActivityReadId = 0;
  let garminActivityStatusKey = '';
  let garminActivityHasSearched = false;
  let garminActivityCanContinue = false;
  const formatActivityStart = (value) => {
    const raw = String(value || '');
    const date = raw.length >= 10 ? formatLocalizedDate(raw.slice(0, 10), i18n.language) : raw;
    const time = raw.length >= 16 ? raw.slice(11, 16) : '';
    return [date, time].filter(Boolean).join(' · ');
  };
  const setGarminActivityStatus = (key) => {
    garminActivityStatusKey = key || '';
    garminActivityStatus.textContent = key ? t(`session.garminImport.${key === 'loadingMore' ? 'loadingMoreStatus' : key}`) : '';
    garminActivityStatus.hidden = !key;
    const attention = key && !['searching', 'importing', 'imported'].includes(key);
    setFeedbackProgress(['searching', 'loadingMore'].includes(key) ? 'garminSearching' : ['downloading', 'importing'].includes(key) ? 'importingResult'
      : key === 'imported' ? null : attention ? 'garminNeedsAttention'
        : garminActivityPreviewId ? 'garminReviewReady' : null);
  };
  const focusGarminActivityError = (target = garminActivityStatus) => {
    setAccordionOpen(feedbackAccordionTrigger, feedbackAccordionPanel, true);
    requestAnimationFrame(() => {
      const visibleTarget = target?.getClientRects?.().length ? target : resultSourceSelect;
      visibleTarget?.focus({ preventScroll: true });
    });
  };
  const renderGarminActivityCandidates = () => {
    garminActivityCandidates.replaceChildren();
    for (const candidate of garminActivityCandidatesState) {
      const card = document.createElement('article');
      card.className = 'garmin-activity-candidate';
      card.setAttribute('role', 'listitem');
      card.classList.toggle('is-selected', selectedGarminActivity?.activity_id === candidate.activity_id);
      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = candidate.name || candidate.sport || t('session.garminImport.unknownActivity');
      info.append(title);
      const detail = document.createElement('p');
      const distanceUnit = getUserPreferences().distance_unit;
      const approximatePace = candidate.approximate_pace_seconds_per_km
        ? `~${formatPaceFromMetric(formatDuration(candidate.approximate_pace_seconds_per_km), distanceUnit)} · ${t('session.garminImport.summaryPace')}` : '';
      const sportKey = String(candidate.sport || '').toLowerCase();
      const sportLabel = t(`session.garminImport.sports.${sportKey}`);
      const sport = sportLabel === `session.garminImport.sports.${sportKey}`
        ? (candidate.sport || t('session.garminImport.unknownActivity')) : sportLabel;
      const detailParts = [formatActivityStart(candidate.start_time_local), sport,
        candidate.duration_seconds == null ? '' : formatDuration(candidate.duration_seconds),
        candidate.distance_m == null ? '' : formatDistance(candidate.distance_m / 1000, distanceUnit), approximatePace,
        candidate.average_hr == null ? '' : `${t('session.garminImport.avgHr')} ${candidate.average_hr}`,
        candidate.max_hr == null ? '' : `${t('session.garminImport.maxHr')} ${candidate.max_hr}`,
        candidate.elevation_gain_m == null ? '' : `${t('session.garminImport.elevation')} ${candidate.elevation_gain_m} m`,
        candidate.calories == null ? '' : `${candidate.calories} ${t('session.resultCalories').toLowerCase()}`];
      detail.textContent = detailParts.filter(Boolean).join(' · ');
      info.append(detail);
      if (candidate.suggestion === 'same_local_date_requires_confirmation') {
        const suggestion = document.createElement('p');
        suggestion.className = 'garmin-activity-suggestion';
        suggestion.textContent = t('session.garminImport.dateSuggestion');
        info.append(suggestion);
      } else {
        const uncertainty = document.createElement('p');
        uncertainty.textContent = t(candidate.suggestion === 'date_differs_requires_confirmation'
          ? 'session.garminImport.dateDifferent' : 'session.garminImport.noMatch');
        info.append(uncertainty);
      }
      if (candidate.linked_training_id) {
        const linked = document.createElement('p');
        linked.textContent = t('session.garminImport.linked').replace('{id}', String(candidate.linked_training_id));
        info.append(linked);
      } else if (candidate.historical_training_id) {
        const linked = document.createElement('p');
        linked.textContent = t('session.garminImport.previouslyLinked').replace('{id}', String(candidate.historical_training_id));
        info.append(linked);
      }
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'btn-secondary btn-small';
      choose.textContent = t('session.garminImport.choose');
      choose.dataset.activityId = String(candidate.activity_id);
      choose.setAttribute('aria-pressed', String(selectedGarminActivity?.activity_id === candidate.activity_id));
      choose.disabled = garminActivityBusy || Boolean(candidate.linked_training_id && candidate.linked_training_id !== Number(currentTrainingId));
      choose.addEventListener('click', () => { void previewGarminActivity(candidate); });
      card.append(info, choose);
      garminActivityCandidates.append(card);
    }
    garminActivityCandidates.hidden = garminActivityCandidatesState.length === 0 || !garminActivityPreview.hidden;
  };
  const updateGarminActivityWindow = () => {
    const date = new Date(`${training?.dia}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) { garminActivityWindow.hidden = true; return; }
    const start = new Date(date.valueOf() - 15 * 86400000).toISOString().slice(0, 10);
    const end = new Date(date.valueOf() + 15 * 86400000).toISOString().slice(0, 10);
    garminActivityWindow.textContent = t(`session.garminImport.${garminActivityHasSearched ? 'searchedWindow' : 'searchWindow'}`)
      .replace('{start}', formatLocalizedDate(start, i18n.language)).replace('{end}', formatLocalizedDate(end, i18n.language));
    garminActivityWindow.hidden = false;
  };
  const readGarminActivity = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body.code || 'import_error'); error.status = response.status; throw error; }
    return body;
  };
  const activityErrorKey = (error) => {
    const allowed = ['session_expired','pilot_unavailable','connection_required','auth_required','rate_limited','connector_timeout','connector_unavailable',
      'connector_busy','connector_configuration_error','connector_invalid_response',
      'invalid_payload','invalid_fit','unsupported_activity','preview_expired','activity_already_linked',
      'activity_evidence_conflict','activity_not_found','confirm_replace','session_changed','connection_changed','import_in_progress','import_error'];
    if (['invalid_zip','unsafe_entry','encrypted_zip','too_many_entries','zip_too_large','fit_too_large',
      'missing_fit','multiple_fit','invalid_file','unsupported_type'].includes(error?.message)) return 'invalid_fit';
    return allowed.includes(error?.message) ? error.message : 'import_error';
  };
  const searchGarminActivities = async (append = false) => {
    if (garminActivityBusy || !currentTrainingId) return;
    garminActivityBusy = true;
    const readId = ++garminActivityReadId;
    const requestedTrainingId = currentTrainingId;
    garminActivitySearch.disabled = true;
    garminActivityRefresh.disabled = true;
    garminActivityMore.disabled = true;
    garminActivitySearch.setAttribute('aria-busy', 'true');
    garminActivityPreview.hidden = true;
    if (append) {
      garminActivityMore.textContent = t('session.garminImport.loadingMore');
      garminActivityMore.setAttribute('aria-busy', 'true');
      garminActivityCandidates.setAttribute('aria-busy', 'true');
    }
    updateGarminActivityWindow();
    setGarminActivityStatus(append ? 'loadingMore' : 'searching');
    try {
      const requestedOffset = append ? garminActivityNextOffset : 0;
      if (append && !garminActivityCanContinue) return;
      const result = await readGarminActivity(`/api/trainings/${encodeURIComponent(requestedTrainingId)}/garmin/activities?offset=${requestedOffset}`);
      if (readId !== garminActivityReadId || currentTrainingId !== requestedTrainingId) return;
      const refreshedItems = result.items || [];
      garminActivityCandidatesState = append ? [...garminActivityCandidatesState, ...refreshedItems] : refreshedItems;
      if (!garminActivityCandidatesState.some((candidate) => candidate.activity_id === selectedGarminActivity?.activity_id)) {
        selectedGarminActivity = null;
      }
      const validContinuation = result.has_more === true && result.budget_exhausted !== true
        && Number.isInteger(result.next_offset) && result.next_offset > requestedOffset;
      if (Number.isInteger(result.next_offset) && result.next_offset >= requestedOffset) {
        garminActivityNextOffset = result.next_offset;
      }
      garminActivityCanContinue = validContinuation;
      garminActivityHasSearched = true;
      updateGarminActivityWindow();
      renderGarminActivityCandidates();
      setGarminActivityStatus(garminActivityCandidatesState.length ? (refreshedItems.length ? '' : (validContinuation ? 'emptyPageMore' : ''))
        : validContinuation ? 'emptyPageMore' : 'none');
      garminActivityMore.hidden = !validContinuation;
      garminActivitySearch.hidden = true;
      garminActivityRefresh.hidden = false;
    } catch (error) {
      if (readId !== garminActivityReadId || currentTrainingId !== requestedTrainingId) return;
      setGarminActivityStatus(activityErrorKey(error));
      if (hasCurrentGarminActivity() || garminActivityHasSearched) garminActivityRefresh.hidden = false;
      if (['connection_required', 'auth_required'].includes(error?.message)) {
        setAccordionOpen(garminAccordionTrigger, garminAccordionPanel, true);
        requestAnimationFrame(() => {
          const target = garminConnectButton.hidden ? garminAuthSubmit : garminConnectButton;
          if (target && !target.hidden) target.focus({ preventScroll: true });
        });
      } else focusGarminActivityError();
    } finally {
      if (readId === garminActivityReadId) {
        garminActivityBusy = false;
        garminActivitySearch.disabled = false;
        garminActivityRefresh.disabled = false;
        garminActivityMore.disabled = false;
        garminActivityMore.textContent = t('session.garminImport.more');
        garminActivityMore.removeAttribute('aria-busy');
        garminActivityCandidates.removeAttribute('aria-busy');
        garminActivitySearch.removeAttribute('aria-busy');
        renderGarminActivityCandidates();
      }
    }
  };
  const previewGarminActivity = async (candidate) => {
    if (garminActivityBusy || !currentTrainingId || !candidate?.activity_id) return;
    garminActivityBusy = true;
    const readId = ++garminActivityReadId;
    const requestedTrainingId = currentTrainingId;
    garminActivityCandidates.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    garminActivityPreview.hidden = true;
    setGarminActivityStatus('downloading');
    try {
      const result = await readGarminActivity(`/api/trainings/${encodeURIComponent(requestedTrainingId)}/garmin/activity-preview`, {
        method: 'POST', body: JSON.stringify({ activity_id: candidate.activity_id, source_cursor: candidate.source_cursor }),
      });
      if (readId !== garminActivityReadId || currentTrainingId !== requestedTrainingId) return;
      selectedGarminActivity = candidate;
      garminActivityPreviewId = result.preview_id;
      const sportKey = String(candidate.sport || '').toLowerCase();
      const sportTranslation = t(`session.garminImport.sports.${sportKey}`);
      const sport = sportTranslation === `session.garminImport.sports.${sportKey}`
        ? (candidate.sport || t('session.garminImport.unknownActivity')) : sportTranslation;
      garminActivityPreviewName.textContent = candidate.name || t('session.garminImport.unknownActivity');
      garminActivityPreviewContext.textContent = [formatActivityStart(candidate.start_time_local), sport].filter(Boolean).join(' · ');
      garminActivityReplaceNotice.hidden = training.result_data_source === 'none';
      garminActivityConfirm.textContent = t(training.result_data_source === 'none'
        ? 'session.garminImport.confirm' : 'session.garminImport.confirmReplace');
      const rows = [
        ['fitDuration', result.metrics.fit_duration], ['fitDistance', result.metrics.fit_distance == null
          ? null : formatDistance(result.metrics.fit_distance, getUserPreferences().distance_unit)],
        ['fitAvgPace', result.metrics.fit_avg_pace ? formatPaceFromMetric(result.metrics.fit_avg_pace, getUserPreferences().distance_unit) : null], ['fitAvgHr', result.metrics.fit_avg_hr],
        ['fitMaxHr', result.metrics.fit_max_hr], ['fitElevation', result.metrics.fit_elevation_gain == null ? null : `${result.metrics.fit_elevation_gain} m`],
        ['resultCalories', result.metrics.fit_calories],
      ];
      garminActivityPreviewData.replaceChildren();
      for (const [labelKey, value] of rows) {
        const wrapper = document.createElement('div'); wrapper.className = 'fit-data-item';
        const label = document.createElement('dt'); label.textContent = t(`session.${labelKey}`);
        const detail = document.createElement('dd'); detail.textContent = value == null ? '-' : String(value);
        wrapper.append(label, detail); garminActivityPreviewData.append(wrapper);
      }
      garminActivityPreview.querySelector('.garmin-activity-summary')?.remove();
      garminActivityPreview.hidden = false;
      garminActivityGuidance.hidden = true;
      garminActivityMore.hidden = true;
      garminActivitySearch.hidden = true;
      garminActivityRefresh.hidden = true;
      garminActivityCandidates.hidden = true;
      setGarminActivityStatus('');
      refreshFeedbackAccordionSummary();
      requestAnimationFrame(() => garminActivityPreviewHeading.focus({ preventScroll: true }));
    } catch (error) {
      if (readId !== garminActivityReadId || currentTrainingId !== requestedTrainingId) return;
      setGarminActivityStatus(activityErrorKey(error));
      focusGarminActivityError();
    } finally {
      if (readId === garminActivityReadId) {
        garminActivityBusy = false;
        renderGarminActivityCandidates();
      }
    }
  };
  garminActivitySearch.addEventListener('click', () => { void searchGarminActivities(); });
  garminActivityRefresh.addEventListener('click', () => { void searchGarminActivities(); });
  garminActivityMore.addEventListener('click', () => { void searchGarminActivities(true); });
  garminActivityBack.addEventListener('click', () => {
    if (garminActivityBusy) return;
    garminActivityPreview.hidden = true;
    garminActivityGuidance.hidden = hasCurrentGarminActivity();
    garminActivitySearch.hidden = hasCurrentGarminActivity() || garminActivityHasSearched;
    garminActivityRefresh.hidden = !garminActivityHasSearched;
    garminActivityMore.hidden = !garminActivityCanContinue;
    garminActivityCandidates.hidden = garminActivityCandidatesState.length === 0;
    garminActivityPreviewId = null;
    setGarminActivityStatus('');
    renderGarminActivityCandidates();
    requestAnimationFrame(() => garminActivityCandidates.querySelector(`[data-activity-id="${CSS.escape(String(selectedGarminActivity?.activity_id || ''))}"]`)?.focus());
  });
  garminActivitySwitch.addEventListener('click', () => {
    if (garminActivityBusy) return;
    if (hasCurrentGarminActivity() && garminActivitySelectionOpen) {
      garminActivitySelectionOpen = false;
      garminActivityPreview.hidden = true;
      garminActivityPreviewId = null;
      garminActivityCandidates.hidden = true;
      garminActivityMore.hidden = true;
      setGarminActivityStatus('');
      syncResultSourceVisibility();
      garminActivitySwitch.focus({ preventScroll: true });
      return;
    }
    garminActivitySelectionOpen = true;
    setGarminActivityStatus('');
    if (resultSourceSelect.value !== 'garmin') {
      resultSourceSelect.value = 'garmin';
    }
    syncResultSourceVisibility();
    garminActivityPreview.hidden = true;
    garminActivityField.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (garminActivityHasSearched && garminActivityCandidatesState.length) {
      garminActivityCandidates.hidden = false;
      garminActivitySearch.hidden = true;
      garminActivityRefresh.hidden = false;
      garminActivityMore.hidden = !garminActivityCanContinue;
      requestAnimationFrame(() => garminActivityCandidates.querySelector(`[data-activity-id="${CSS.escape(String(training?.garmin_activity?.activity_id || ''))}"]`)?.focus()
        || garminActivityRefresh.focus());
    } else {
      void searchGarminActivities();
      requestAnimationFrame(() => garminActivityStatus.focus({ preventScroll: true }));
    }
  });
  document.addEventListener('app:languagechange', () => {
    renderGarminActivityCandidates();
    setGarminActivityStatus(garminActivityStatusKey);
    if (resultSourceSelect.value === 'garmin') updateGarminActivityWindow();
    if (!garminActivityBusy) {
      garminActivitySearch.textContent = t('session.garminImport.searchInitial');
      garminActivitySwitch.textContent = t(garminActivitySelectionOpen
        ? 'session.garminImport.backToCurrentResult' : 'session.garminImport.switchActivity');
      garminActivityRefresh.textContent = t('session.garminImport.refresh');
      garminActivityMore.textContent = t('session.garminImport.more');
      garminActivityBack.textContent = t('session.garminImport.back');
      garminActivityConfirm.textContent = t(training?.result_data_source === 'none'
        ? 'session.garminImport.confirm' : 'session.garminImport.confirmReplace');
      garminActivityPreviewName.textContent = selectedGarminActivity?.name || t('session.garminImport.unknownActivity');
      const key = String(selectedGarminActivity?.sport || '').toLowerCase();
      const translatedSport = t(`session.garminImport.sports.${key}`);
      garminActivityPreviewContext.textContent = selectedGarminActivity
        ? [formatActivityStart(selectedGarminActivity.start_time_local), translatedSport === `session.garminImport.sports.${key}`
          ? (selectedGarminActivity.sport || t('session.garminImport.unknownActivity')) : translatedSport].filter(Boolean).join(' · ') : '';
    }
    if (fitData) renderFitData();
  });
  garminActivityConfirm.addEventListener('click', async () => {
    if (garminActivityBusy || !garminActivityPreviewId || !currentTrainingId) return;
    const requestedTrainingId = currentTrainingId;
    garminActivityBusy = true;
    garminActivityConfirm.disabled = true;
    let confirmReplace = false;
    if (training.result_data_source !== 'none') {
      confirmReplace = await showConfirm({ title: t('session.garminImport.replaceTitle'),
        message: t('session.garminImport.replaceMessage'), icon: 'triangle-alert',
        confirmLabel: t('session.replaceConfirm'), cancelLabel: t('shell.confirm.no') });
      if (!confirmReplace) { garminActivityBusy = false; garminActivityConfirm.disabled = false; return; }
    }
    garminActivityConfirm.setAttribute('aria-busy', 'true');
    garminActivityConfirm.textContent = t('session.garminImport.importing');
    setGarminActivityStatus('importing');
    feedbackPersistenceSnapshot = feedbackSignature({ omitFile: true });
    try {
      const result = await readGarminActivity(`/api/trainings/${encodeURIComponent(requestedTrainingId)}/garmin/activity-import`, {
        method: 'POST', body: JSON.stringify({ preview_id: garminActivityPreviewId, confirm_replace: confirmReplace }),
      });
      if (!result.training || currentTrainingId !== requestedTrainingId) return;
      const previousTraining = training;
      training = { ...previousTraining, ...result.training };
      for (const key of Object.keys(previousTraining)) {
        if (key.startsWith('feedback_')) training[key] = previousTraining[key];
      }
      fitData = { ...result.training, laps: JSON.parse(result.training.fit_summary_json || '{}').laps || [] };
      garminActivitySelectionOpen = false;
      resultSourceSelect.value = 'garmin';
      garminActivityPreviewId = null;
      garminActivityPreview.hidden = true;
      renderFitData();
      setGarminActivityStatus(result.duplicate ? 'imported' : 'imported');
      refreshFeedbackAccordionSummary();
      requestAnimationFrame(() => garminActivitySwitch.focus({ preventScroll: true }));
    } catch (error) {
      setGarminActivityStatus(activityErrorKey(error));
      focusGarminActivityError();
      if (['session_changed','connection_changed'].includes(error?.message)) {
        const current = await fetchTraining(requestedTrainingId).catch(() => null);
        if (current) applyCanonicalTraining(current, { preserveFeedbackBaseline: true });
      }
    } finally {
      garminActivityBusy = false;
      garminActivityConfirm.disabled = false;
      garminActivityConfirm.removeAttribute('aria-busy');
      garminActivityConfirm.textContent = t(training?.result_data_source === 'none'
        ? 'session.garminImport.confirm' : 'session.garminImport.confirmReplace');
      feedbackPersistenceSnapshot = null;
      setFeedbackProgress(null);
      refreshFeedbackAccordionSummary();
    }
  });

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
      document.getElementById('garminActivityLink').hidden = true;
      document.getElementById('garminActivityLink').textContent = '';
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
      syncResultSourceVisibility();
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
    const activityLink = document.getElementById('garminActivityLink');
    const activityId = training?.garmin_activity?.activity_id;
    activityLink.hidden = source !== 'garmin_connect' || !activityId;
    activityLink.textContent = activityLink.hidden ? '' : t('session.garminActivityLink').replace('{id}', String(activityId));
    garminActivitySwitch.hidden = !hasCurrentGarminActivity();
    garminActivitySwitch.textContent = t(garminActivitySelectionOpen
      ? 'session.garminImport.backToCurrentResult' : 'session.garminImport.switchActivity');
    renderLapsTable();
    syncResultSourceVisibility();
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

  const sessionUser = await initShell();
  i18n = getShellI18n();
  garminActivitySearch.textContent = t('session.garminImport.searchInitial');
  garminActivityRefresh.textContent = t('session.garminImport.refresh');
  garminActivityMore.textContent = t('session.garminImport.more');
  garminActivityBack.textContent = t('session.garminImport.back');
  garminActivityConfirm.textContent = t('session.garminImport.confirm');
  let externalPromptButton = null;
  let externalPromptDialog = null;
  let externalPromptComponent = null;
  let externalPromptTrap = null;
  let externalPromptReturnFocus = null;
  let externalPromptText = '';
  let externalPromptStatusKey = '';
  let externalPromptPending = false;
  if (sessionUser?.role === 'admin') {
    externalPromptButton = document.createElement('button');
    externalPromptButton.type = 'button';
    externalPromptButton.className = 'btn-secondary';
    externalPromptButton.dataset.analysisExternalPrompt = 'true';
    const promptIcon = document.createElement('i');
    promptIcon.dataset.lucide = 'sparkles';
    promptIcon.setAttribute('aria-hidden', 'true');
    const promptLabel = document.createElement('span');
    promptLabel.textContent = t('session.analysis.externalPrompt');
    externalPromptButton.append(promptIcon, promptLabel);
    formActions.classList.add('has-admin-prompt');
    formActions.insertBefore(externalPromptButton, generateBtn);
    const promptModal = createExternalPromptModal({
      id: 'analysisExternalPromptDialog',
      titleId: 'analysisExternalPromptTitle',
      title: t('session.analysis.externalPrompt'),
      closeLabel: analysisKey('close'),
      copyLabel: analysisKey('copyPrompt'),
      closeButtonId: 'analysisExternalPromptClose',
      closeActionId: 'analysisExternalPromptDone',
      copyButtonId: 'analysisExternalPromptCopy',
      statusId: 'analysisExternalPromptStatus',
    });
    externalPromptComponent = promptModal;
    externalPromptDialog = promptModal.dialog;
    const promptClose = promptModal.closeButton;
    const promptDone = promptModal.closeAction;
    const promptCopy = promptModal.copyAction;
    const closeExternalPrompt = () => {
      externalPromptTrap.deactivate();
      externalPromptDialog.hidden = true;
      if (externalPromptReturnFocus?.isConnected) externalPromptReturnFocus.focus();
    };
    externalPromptTrap = createDialogFocusTrap(externalPromptDialog, closeExternalPrompt);
    promptClose.addEventListener('click', closeExternalPrompt);
    promptDone.addEventListener('click', closeExternalPrompt);
    externalPromptButton.addEventListener('click', async () => {
      if (externalPromptPending) return;
      const rpe = requireFeedbackRpe();
      if (rpe === null) return;
      externalPromptPending = true;
      externalPromptButton.disabled = true;
      saveBtn.disabled = true;
      generateBtn.disabled = true;
      promptLabel.textContent = analysisKey('saving');
      setFeedbackProgress('savingChanges');
      feedbackPersistenceSnapshot = feedbackSignature();
      try {
        const saved = await persistCurrentState(rpe);
        if (saved.status !== 'saved') {
          reportPersistenceFailure(saved);
          return;
        }
        externalPromptReturnFocus = externalPromptButton;
        externalPromptDialog.hidden = false;
        externalPromptTrap.activate();
        promptClose.focus();
        promptModal.setPrompt('');
        externalPromptStatusKey = 'loadingPrompt';
        setFeedbackProgress('analysisInProgress');
        promptModal.setStatus(t(`session.analysis.${externalPromptStatusKey}`));
        const result = await previewAnalysisPrompt(currentTrainingId);
        externalPromptText = result.prompt;
        promptModal.setPrompt(externalPromptText);
        externalPromptStatusKey = '';
        promptModal.setStatus('');
      } catch {
        if (externalPromptDialog.hidden) { setStatus(t('session.analysis.promptUnavailable'), 'error'); revealFeedbackError(); }
        else {
          externalPromptStatusKey = 'promptUnavailable';
          promptModal.setStatus(t(`session.analysis.${externalPromptStatusKey}`));
        }
      } finally {
        externalPromptPending = false;
        externalPromptButton.disabled = false;
        saveBtn.disabled = false;
        renderAnalysis();
        promptLabel.textContent = analysisKey('externalPrompt');
        feedbackPersistenceSnapshot = null;
        setFeedbackProgress(null);
        refreshFeedbackAccordionSummary();
      }
    });
    promptCopy.addEventListener('click', async () => {
      const copied = await copyAnalysisPrompt(externalPromptText);
      externalPromptStatusKey = copied ? 'promptCopied' : 'promptCopyFailed';
      promptModal.setStatus(analysisKey(externalPromptStatusKey));
    });
  }
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
    if (training) {
      const summary = summarizePrescription(training.detalhes, {
        language: i18n.language,
        fallbackRpe: training.rpe,
        fallbackHr: training.fc_alvo,
        hrFallback: t('aiCoach.weeklyNoHrReference'),
      });
      document.getElementById('plannedRpe').textContent = summary.rpe;
      document.getElementById('plannedFcAlvo').textContent = summary.hr;
    }
    if (!saveBtn.disabled) saveBtn.textContent = t('session.save');
    if (!generateBtn.disabled) generateLabel.textContent = analysisKey('analyze');
    analysisLoadMessage.textContent = analysisKey(analysisLoadErrorKey);
    analysisLoadAgain.textContent = analysisKey('readAgain');
    if (externalPromptButton) {
      if (!externalPromptPending) externalPromptButton.querySelector('span').textContent = analysisKey('externalPrompt');
      externalPromptComponent?.setLabels({
        title: analysisKey('externalPrompt'),
        close: analysisKey('close'),
        copy: analysisKey('copyPrompt'),
      });
      if (externalPromptStatusKey)
        externalPromptComponent?.setStatus(analysisKey(externalPromptStatusKey));
    }
    if (analysisNotice.dataset.key) analysisNotice.textContent = analysisKey(analysisNotice.dataset.key);
    renderAnalysis();
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
  const garminCard = document.getElementById('garminSessionCard');
  const garminText = (key, params) => t(`garmin.product.${key}`, params);
  const garminStatus = document.getElementById('garminConnectionStatus');
  const garminConnectionRetry = document.getElementById('garminConnectionRetry');
  const garminAuthForm = document.getElementById('garminAuthForm');
  const garminConnectButton = document.getElementById('garminConnectButton');
  const garminDisconnectButton = document.getElementById('garminDisconnectButton');
  const garminDisconnectHelp = document.getElementById('garminDisconnectHelp');
  const garminMfaField = document.getElementById('garminMfaField');
  const garminMfaCode = document.getElementById('garminMfaCode');
  const garminPassword = document.getElementById('garminPassword');
  const garminEmail = document.getElementById('garminEmail');
  const garminAuthSubmit = document.getElementById('garminAuthSubmit');
  const garminAuthProgress = document.getElementById('garminAuthProgress');
  const garminCancel = document.getElementById('garminAuthCancel');
  const garminPanel = document.getElementById('garminPrescriptionPanel');
  const garminEditorView = document.getElementById('garminEditorView');
  const garminPrescriptionForm = document.getElementById('garminPrescriptionForm');
  const garminPreview = document.getElementById('garminPreview');
  const garminPreviewSteps = document.getElementById('garminPreviewSteps');
  const garminOperationStatus = document.getElementById('garminOperationStatus');
  const garminEditStructure = document.getElementById('garminEditStructure');
  const garminOperationRetry = document.getElementById('garminOperationRetry');
  const garminReconcileButton = document.getElementById('garminReconcileButton');
  const garminUpdateButton = document.getElementById('garminUpdateButton');
  const garminRescheduleButton = document.getElementById('garminRescheduleButton');
  let garminChallenge = null;
  let garminFingerprint = null;
  let garminVisible = false;
  let garminPending = false;
  let garminConnectionMessage = 'loading';
  let garminCurrentOperation = null;
  let garminOperationMessageKey = null;
  let garminPreviewModel = null;
  let garminSavedRevision = null;
  let garminFormDirty = false;
  let garminEditingRequested = false;
  let garminStatusRead = 0;
  let garminStatusPromise = null;
  let garminConnectionActionBusy = false;
  let garminConnectionKnown = false;
  let garminStatusUnavailable = false;
  let garminOperationTimer = null;
  let garminOperationController = null;
  let garminOperationRead = 0;
  let garminOperationId = null;
  let garminRemoteActionToken = 0;
  let garminDispatchUncertain = false;
  let garminStatusRetryAvailable = false;
  let garminAuthPhase = null;
  let garminAuthAttempt = 0;
  let garminDestinationNames = [];
  let garminPreviewSnapshot = null;
  let garminConnected = false;
  let garminConnectionGeneration = 1;
  let garminOriginalPrescription = null;
  let garminEditorSteps = [{ id: 'run-1', kind: 'run', end: { type: 'time', value: 1800 }, target: { type: 'none' } }];
  let garminWarmupDraftEnabled = false;
  let garminCooldownDraftEnabled = false;
  let garminOptionalDraft = { warmup: null, cooldown: null };
  const refreshGarminAccordionSummary = () => {
    const operation = garminCurrentOperation;
    let key = 'garminLoading';
    const authErrors = ['authFailed', 'authRateLimited', 'disconnectFailed'].includes(garminConnectionMessage);
    const connectionUnavailable = garminStatusUnavailable
      || ['connectionRefreshFailed', 'connectError', 'authUnavailable', 'disconnectPending'].includes(garminConnectionMessage);
    const operationProgress = {
      checkingReview: 'garminCheckingReview',
      publishing: 'garminSending',
      updating: 'garminUpdating',
      rescheduling: 'garminRescheduling',
      verifyingResult: 'garminAwaitingConfirmation',
    }[garminOperationMessageKey];
    if (garminAuthPhase === 'validatingMfa') key = 'garminMfaValidating';
    else if (garminAuthPhase && garminChallenge) key = 'garminMfaInProgress';
    else if (garminAuthPhase) key = 'garminConnecting';
    else if (operationProgress) key = operationProgress;
    else if (connectionUnavailable) key = 'garminConnectionUnavailable';
    else if (garminConnectionMessage === 'connectionReauthRequired' || operation?.status === 'reauth_required') key = 'garminReauthenticationRequired';
    else if (authErrors) key = 'garminAuthenticationNeedsAttention';
    else if (garminConnectionMessage === 'mfaRequired' || garminChallenge) key = 'garminMfaInProgress';
    else if (operation?.status === 'outcome_unknown') key = 'garminAwaitingConfirmation';
    else if (['publishing', 'workout_created', 'scheduling'].includes(operation?.status)) {
      key = operation.action === 'update' ? 'garminUpdating'
        : operation.action === 'reschedule' ? 'garminRescheduling' : 'garminSending';
    } else if (operation?.status === 'failed') key = 'garminOperationNeedsAttention';
    else if (operation?.status === 'outdated') key = 'garminStructureOutdated';
    else if (garminConnectionKnown && !garminConnected && garminConnectionMessage === 'disconnected') {
      key = operation?.status === 'scheduled' ? 'garminDisconnectedPreviouslySent' : 'garminDisconnected';
    } else if (operation?.status === 'scheduled') key = 'garminSentScheduled';
    else if (garminConnectionKnown && garminConnected) key = garminFingerprint || garminSavedRevision !== null ? 'garminConnectedSaved' : 'garminConnectedEmpty';
    else if (garminConnectionKnown && garminConnectionMessage === 'disconnected') key = 'garminDisconnected';
    const text = t(`session.accordion.${key}`);
    if (garminAccordionSummary.textContent !== text) garminAccordionSummary.textContent = text;
  };
  document.addEventListener('app:languagechange', refreshGarminAccordionSummary);
  const setGarminOperationMessage = (key) => {
    garminOperationMessageKey = key;
    garminOperationStatus.textContent = garminText(key);
    refreshGarminAccordionSummary();
  };
  const setGarminConnectionMessage = (key) => {
    garminConnectionMessage = key;
    garminStatus.textContent = garminText(key);
    refreshGarminAccordionSummary();
  };
  const garminOperationNeedsResolution = (operation = garminCurrentOperation) => Boolean(operation
    && ['publishing', 'workout_created', 'scheduling', 'outcome_unknown', 'reauth_required', 'failed'].includes(operation.status));
  const garminFetch = async (url, options = {}) => {
    const headers = { ...options.headers };
    if (options.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(url, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body.code || 'unavailable'); error.status = response.status; error.diagnostic = body.diagnostic; throw error; }
    return body;
  };
  const readGarminStatus = async () => {
    const read = ++garminStatusRead;
    garminVisible = true;
    garminCard.hidden = false;
    // The canonical prescription and operation state are local Node reads.
    // Load them first so a stopped connector cannot hide saved work.
    try {
      const local = await garminFetch(`/api/trainings/${encodeURIComponent(currentTrainingId)}/garmin`);
      if (read !== garminStatusRead) return;
      if (local.prescription) {
        garminSavedRevision = local.prescription.revision;
        garminFingerprint = local.prescription.fingerprint;
        if (!garminFormDirty && !garminEditingRequested) fillGarminPrescription(local.prescription.value);
        garminPreviewSnapshot = { revision: local.prescription.revision, fingerprint: local.prescription.fingerprint,
          date: local.training_date || training.dia, connection_generation: local.connection_generation };
        if (!garminFormDirty && !garminEditingRequested && local.prescription.preview) {
          garminEditorView.hidden = true;
          renderGarminPreview({ name: local.prescription.value.name,
            ...local.prescription.preview, date: local.training_date || training.dia });
        }
      }
      garminConnectionGeneration = local.connection_generation || garminConnectionGeneration;
      if (local.operation) { garminDispatchUncertain = false; renderGarminOperation(local.operation); }
      else if (garminDispatchUncertain) {
        garminDispatchUncertain = false;
        garminOperationStatus.textContent = '';
        garminOperationRetry.hidden = true;
      }
    } catch (error) {
      if (read !== garminStatusRead) return;
      if (error.status === 404) { garminCard.hidden = true; return; }
    }
    try {
      const state = await garminFetch(`/api/garmin/status?training_id=${encodeURIComponent(currentTrainingId)}`);
      if (read !== garminStatusRead) return;
      garminVisible = true;
      garminCard.hidden = false;
      const connected = state.status === 'connected';
      garminConnected = connected;
      garminConnectionKnown = true;
      garminStatusUnavailable = false;
      garminConnectionRetry.hidden = true;
      const connectionMessage = state.status === 'reauthentication_required'
        ? 'connectionReauthRequired' : state.status === 'mfa_required' ? 'mfaRequired'
          : connected ? 'connected' : 'disconnected';
      setGarminConnectionMessage(connectionMessage);
      const destination = document.getElementById('garminDestination');
      garminDestinationNames = connected ? (state.devices || []).map((device) => device.name).filter(Boolean) : [];
      destination.hidden = garminDestinationNames.length === 0;
      destination.textContent = garminDestinationNames.length ? `${garminText('accountDevice')}: ${garminDestinationNames.join(', ')}` : '';
      garminConnectButton.hidden = connected || garminAuthForm.hidden === false;
      garminDisconnectButton.hidden = !connected;
      garminAuthForm.hidden = connected || !garminAuthForm.dataset.open;
      garminPanel.hidden = !connected || training?.completed === 1;
      if (state.operation) renderGarminOperation(state.operation);
      if (state.prescription && !garminFormDirty && !garminEditingRequested) {
        fillGarminPrescription(state.prescription.value);
        garminSavedRevision = state.prescription.revision;
        garminFingerprint = state.prescription.fingerprint;
        if (state.prescription.preview) {
          garminPreviewSnapshot = { revision: state.prescription.revision, fingerprint: state.prescription.fingerprint,
            date: state.training_date || training.dia, connection_generation: state.connection_generation };
          garminEditorView.hidden = true;
          renderGarminPreview({ name: state.prescription.value.name, ...state.prescription.preview,
            date: state.training_date || training.dia });
        }
      }
      garminConnectionGeneration = state.connection_generation || garminConnectionGeneration;
    } catch (error) {
      if (read !== garminStatusRead) return;
      if (error.status === 404) { garminCard.hidden = true; return; }
      if (error.message === 'auth_required') {
        garminConnectionKnown = true;
        garminConnected = false;
        garminStatusUnavailable = false;
        setGarminConnectionMessage('connectionReauthRequired');
        garminConnectionRetry.hidden = true;
        garminConnectButton.hidden = garminAuthForm.hidden === false;
        garminDisconnectButton.hidden = true;
        garminPanel.hidden = true;
      } else if (error.message === 'cleanup_pending') {
        garminConnectionKnown = true;
        garminConnected = false;
        garminStatusUnavailable = true;
        garminDestinationNames = [];
        const destination = document.getElementById('garminDestination');
        destination.hidden = true;
        destination.textContent = '';
        garminConnectButton.hidden = true;
        garminDisconnectButton.hidden = true;
        garminPanel.hidden = true;
        garminConnectionRetry.hidden = false;
        setGarminConnectionMessage('disconnectPending');
      } else {
        setGarminConnectionMessage(garminConnectionKnown ? 'connectionRefreshFailed' : 'connectError');
        garminStatusUnavailable = true;
        garminConnectionRetry.hidden = false;
        if (!garminConnectionKnown) garminPanel.hidden = !garminFingerprint;
      }
      if (garminPreviewModel) renderGarminPreview(garminPreviewModel);
    }
  };
  const renderGarminStatus = () => {
    if (garminStatusPromise) return garminStatusPromise;
    const pending = readGarminStatus();
    garminStatusPromise = pending.finally(() => {
      if (garminStatusPromise === wrapped) {
        garminStatusPromise = null;
        garminConnectionRetry.disabled = false;
        garminConnectionRetry.removeAttribute('aria-disabled');
      }
    });
    const wrapped = garminStatusPromise;
    return wrapped;
  };
  const refreshGarminStatus = async () => {
    const previous = garminStatusPromise;
    if (previous) {
      garminStatusRead += 1;
      await Promise.allSettled([previous]);
    }
    return renderGarminStatus();
  };
  garminConnectionRetry.addEventListener('click', () => {
    if (garminStatusPromise || garminConnectionRetry.getAttribute('aria-disabled') === 'true') return;
    // Keep focus on the retry action while preventing duplicate requests.
    // Native disabled removes the focused button from interaction and drops
    // focus in several browsers; aria-disabled plus the in-flight guard keeps
    // the state perceivable and keyboard focus stable.
    garminConnectionRetry.setAttribute('aria-disabled', 'true');
    garminStatusUnavailable = true;
    setGarminConnectionMessage('connectionChecking');
    if (garminPreviewModel) renderGarminPreview(garminPreviewModel);
    void renderGarminStatus();
  });
  const editorTargetMarkup = (prefix, target = { type: 'none' }) => {
    const pace = target.type === 'pace';
    const hr = target.type === 'heart_rate';
    const paceUnit = target.unit || (getUserPreferences().distance_unit === 'mi' ? 'min_per_mile' : 'min_per_km');
    const paceUnitLabel = paceUnit === 'min_per_mile' ? 'mi' : 'km';
    const lower = pace ? target.slower_seconds : hr ? target.lower_bpm : '';
    const upper = pace ? target.faster_seconds : hr ? target.upper_bpm : '';
    const paceText = (seconds) => { const total = Math.round(seconds); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };
    const lowerLabel = pace ? garminText('slowerPaceUnit', { unit: paceUnitLabel }) : garminText('lowerHeartRate');
    const upperLabel = pace ? garminText('fasterPaceUnit', { unit: paceUnitLabel }) : garminText('upperHeartRate');
    const lowerId = `garmin-target-${prefix}-lower`;
    const upperId = `garmin-target-${prefix}-upper`;
    const input = (side, id, label, value, placeholder, isPace) => `<label for="${id}"><span data-target-${side}-label="${prefix}">${label}</span><input id="${id}" data-target-${side}="${prefix}" class="input-control" type="${isPace ? 'text' : 'number'}" ${isPace ? `inputmode="numeric" placeholder="${placeholder}"` : `inputmode="numeric" min="40" max="230" step="1" placeholder="${placeholder}"`} value="${value}" ${pace || hr ? 'required' : ''} aria-label="${label}"><span id="${id}-error" class="garmin-field-error" data-validation-error hidden></span></label>`;
    return `<label class="garmin-target-select">${garminText('target')}<select data-target-type="${prefix}" data-previous-type="${target.type}" data-pace-unit="${paceUnit}" class="input-control"><option value="none" ${!pace && !hr ? 'selected' : ''}>${garminText('noTarget')}</option><option value="pace" ${pace ? 'selected' : ''}>${garminText('paceShort')}</option><option value="heart_rate" ${hr ? 'selected' : ''}>${garminText('heartRateShort')}</option></select></label><div class="garmin-editor-target" data-target-fields="${prefix}" ${!pace && !hr ? 'hidden' : ''}>${input('lower', lowerId, lowerLabel, pace ? paceText(lower) : hr ? lower : '', pace ? '5:30' : '140', pace)}${input('upper', upperId, upperLabel, pace ? paceText(upper) : hr ? upper : '', pace ? '5:45' : '150', pace)}</div>`;
  };
  const updateGarminTargetPresentation = (select) => {
    const fields = document.querySelector(`[data-target-fields="${select.dataset.targetType}"]`);
    const pace = select.value === 'pace'; const hr = select.value === 'heart_rate';
    if (fields) fields.hidden = !pace && !hr;
    const unit = select.dataset.paceUnit === 'min_per_mile' ? 'mi' : 'km';
    const controls = [
      [fields?.querySelector(`[data-target-lower="${select.dataset.targetType}"]`), pace ? 'slowerPaceUnit' : 'lowerHeartRate', pace ? '5:30' : '140'],
      [fields?.querySelector(`[data-target-upper="${select.dataset.targetType}"]`), pace ? 'fasterPaceUnit' : 'upperHeartRate', pace ? '5:45' : '150'],
    ];
    for (const [input, key, placeholder] of controls) if (input) {
      const label = input.parentElement.querySelector('span');
      const translated = pace ? garminText(key, { unit }) : garminText(key);
      if (label) label.textContent = translated;
      input.type = pace ? 'text' : 'number'; input.inputMode = 'numeric'; input.required = pace || hr;
      input.min = pace ? '' : '40'; input.max = pace ? '' : '230'; input.step = pace ? '' : '1';
      input.placeholder = placeholder; input.setAttribute('aria-label', translated);
    }
  };
  const editorEndMarkup = (prefix, end = { type: 'time', value: 600 }) => {
    const unit = getUserPreferences().distance_unit === 'mi' ? 'mi' : 'km';
    const value = end.type === 'time' ? (Number.isFinite(Number(end.value)) && Number(end.value) > 0 ? `${Math.floor(end.value / 60)}:${String(end.value % 60).padStart(2, '0')}` : '')
      : String((end.value / (unit === 'mi' ? 1609.344 : 1000)).toFixed(6)).replace(/\.?0+$/, '');
    const inputId = `garmin-end-${prefix}`;
    const helpId = `${inputId}-help`;
    const time = end.type === 'time';
    const labelKey = time ? 'durationMmSs' : unit === 'mi' ? 'distanceMi' : 'distanceKm';
    return `<div class="garmin-editor-end"><label for="garmin-end-type-${prefix}">${garminText('endCondition')}<select id="garmin-end-type-${prefix}" data-end-type="${prefix}" class="input-control"><option value="time" ${time ? 'selected' : ''}>${garminText('byTime')}</option><option value="distance" ${!time ? 'selected' : ''}>${garminText('byDistance')}</option></select></label><label for="${inputId}"><span data-end-label="${prefix}">${garminText(labelKey)}</span><input id="${inputId}" data-end-value="${prefix}" class="input-control" value="${value}" inputmode="${time ? 'text' : 'decimal'}" required aria-label="${garminText(labelKey)}" ${time ? `aria-describedby="${helpId}"` : ''}><small id="${helpId}" class="garmin-field-help" ${time ? '' : 'hidden'}>${garminText(time ? 'durationHelp' : 'distanceHelp', { unit })}</small><span id="${inputId}-error" class="garmin-field-error" data-validation-error hidden></span></label></div>`;
  };
  const renderGarminEditor = (preserve = false) => {
    const savedControls = preserve ? [...document.querySelectorAll('#garminWorkoutEditor [data-end-value], #garminWorkoutEditor [data-end-type], #garminWorkoutEditor [data-target-type], #garminWorkoutEditor [data-target-lower], #garminWorkoutEditor [data-target-upper], #garminWorkoutEditor [data-repetitions], #garminWorkoutEditor [data-recovery-enabled], #garminWorkoutEditor [data-skip-last]')].map((el) => ({
      key: ['data-end-value', 'data-end-type', 'data-target-type', 'data-target-lower', 'data-target-upper', 'data-repetitions', 'data-recovery-enabled', 'data-skip-last'].map((attr) => el.hasAttribute(attr) ? `${attr}:${el.getAttribute(attr)}` : null).find(Boolean),
      value: el.type === 'checkbox' ? el.checked : el.value,
    })) : [];
    const unit = getUserPreferences().distance_unit === 'mi' ? 'mi' : 'km';
    const renderStage = (kind, value) => `<div class="garmin-editor-fields">${editorEndMarkup(kind, value?.end || garminOptionalDraft[kind]?.end || { type: 'time', value: 600 })}${editorTargetMarkup(kind, value?.target || garminOptionalDraft[kind]?.target || { type: 'none' })}</div>`;
    const warm = garminEditorSteps.find((step) => step.kind === 'warmup');
    const cool = garminEditorSteps.find((step) => step.kind === 'cooldown');
    const warmToggle = document.getElementById('garminWarmupEnabled');
    const coolToggle = document.getElementById('garminCooldownEnabled');
    if (warmToggle) warmToggle.checked = garminWarmupDraftEnabled;
    if (coolToggle) coolToggle.checked = garminCooldownDraftEnabled;
    document.getElementById('garminWarmupEditor').hidden = !warmToggle?.checked;
    document.getElementById('garminCooldownEditor').hidden = !coolToggle?.checked;
    document.getElementById('garminWarmupEditor').innerHTML = renderStage('warmup', warm);
    document.getElementById('garminCooldownEditor').innerHTML = renderStage('cooldown', cool);
    for (const [id, enabled] of [['garminWarmupEditor', warmToggle?.checked], ['garminCooldownEditor', coolToggle?.checked]]) {
      document.querySelectorAll(`#${id} input, #${id} select`).forEach((control) => { control.disabled = !enabled; });
    }
    const runSteps = garminEditorSteps.filter((step) => ['run', 'repeat', 'recovery'].includes(step.kind));
    const runStepCount = runSteps.filter((step) => ['run', 'repeat'].includes(step.kind)).length;
    document.getElementById('garminRunBlocks').innerHTML = runSteps.map((step, index) => {
      const prefix = `step-${step.id}`;
      const repetition = step.kind === 'repeat';
      const recovery = step.recovery;
      const cannotRemove = ['run', 'repeat'].includes(step.kind) && runStepCount <= 1;
      const titleKey = repetition ? 'repeatBlock' : step.kind === 'recovery' ? 'recoveryBlock' : 'runBlock';
      const legacyRepeat = repetition && !recovery && garminOriginalPrescription && garminOriginalPrescription.version < 3;
      return `<fieldset class="garmin-editor-block" data-block-id="${step.id}"><legend tabindex="-1">${garminText(titleKey)} ${index + 1}</legend><div class="garmin-editor-fields">${legacyRepeat ? `<p class="garmin-editor-warning" role="note">${garminText('legacyRepeatRecoveryRequired')} <button type="button" class="btn-secondary" data-editor-action="convert-repeat" data-id="${step.id}">${garminText('convertRepeatToBlocks')}</button></p>` : ''}${repetition ? `<p class="garmin-repeat-intro">${garminText('repeatRun')}</p>` : ''}${editorEndMarkup(prefix, step.interval?.end || step.end)}${editorTargetMarkup(`${prefix}-target`, step.interval?.target || step.target)}${repetition ? `<label for="garmin-repetitions-${step.id}">${garminText('repetitionCount')}<input id="garmin-repetitions-${step.id}" data-repetitions="${step.id}" class="input-control" type="number" min="2" max="20" value="${step.repetitions}" required><span id="garmin-repetitions-${step.id}-error" class="garmin-field-error" data-validation-error hidden></span></label><p class="garmin-repeat-intro">${garminText('repeatRecovery')}</p>${editorEndMarkup(`${prefix}-recovery`, recovery?.end || { type: 'time', value: '' })}${editorTargetMarkup(`${prefix}-recovery-target`, recovery?.target || { type: 'none' })}<label class="garmin-inline-check garmin-skip-rest"><input data-skip-last="${step.id}" type="checkbox" ${step.skip_last_rest_step ? 'checked' : ''}><span>${garminText('skipLastRecovery')}</span></label>` : ''}</div><div class="garmin-editor-actions"><button type="button" data-editor-action="up" data-id="${step.id}" aria-label="${garminText('moveUp')}" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-editor-action="down" data-id="${step.id}" aria-label="${garminText('moveDown')}" ${index === runSteps.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-editor-action="duplicate" data-id="${step.id}" aria-label="${garminText('duplicateBlock')}">${garminText('duplicateBlock')}</button><button type="button" data-editor-action="remove" data-id="${step.id}" aria-label="${garminText('removeBlock')}" ${cannotRemove ? 'disabled' : ''}>${garminText('removeBlock')}</button></div></fieldset>`;
    }).join('');
    document.querySelectorAll('[data-target-type]').forEach((select) => {
      select.addEventListener('change', () => {
        const pace = select.value === 'pace';
        if (pace) {
          select.dataset.paceUnit = getUserPreferences().distance_unit === 'mi' ? 'min_per_mile' : 'min_per_km';
        }
        const lower = document.querySelector(`[data-target-lower="${select.dataset.targetType}"]`);
        const upper = document.querySelector(`[data-target-upper="${select.dataset.targetType}"]`);
        if (lower) lower.value = '';
        if (upper) upper.value = '';
        updateGarminTargetPresentation(select);
        clearGarminFieldError(lower); clearGarminFieldError(upper);
        select.dataset.previousType = select.value;
        markGarminEditorDirty();
      });
    });
    document.querySelectorAll('[data-end-type]').forEach((select) => select.addEventListener('change', () => {
      const input = document.querySelector(`[data-end-value="${select.dataset.endType}"]`);
      if (input) input.value = '';
      const label = document.querySelector(`[data-end-label="${select.dataset.endType}"]`);
      const time = select.value === 'time';
      if (label) label.textContent = garminText(time ? 'durationMmSs' : unit === 'mi' ? 'distanceMi' : 'distanceKm');
      const help = document.getElementById(`${input?.id}-help`);
      if (help) help.hidden = !time;
      if (input) {
        input.inputMode = time ? 'text' : 'decimal';
        if (time) input.setAttribute('aria-describedby', help?.id || '');
        else input.removeAttribute('aria-describedby');
        clearGarminFieldError(input);
      }
      markGarminEditorDirty();
    }));
    for (const saved of savedControls) {
      const [attribute, value] = (saved.key || '').split(/:(.*)/s).slice(0, 2);
      if (!attribute) continue;
      const control = [...document.querySelectorAll(`#garminWorkoutEditor [${attribute}]`)].find((el) => el.getAttribute(attribute) === value);
      if (control) {
        if (attribute === 'data-target-lower' || attribute === 'data-target-upper') {
          const prefix = attribute === 'data-target-lower' ? 'data-target-lower' : 'data-target-upper';
          const targetId = value;
          const selector = [...document.querySelectorAll('#garminWorkoutEditor [data-target-type]')].find((select) =>
            document.querySelector(`[data-target-fields="${select.dataset.targetType}"] [${prefix}="${CSS.escape(targetId)}"]`));
          control.type = selector?.value === 'pace' ? 'text' : 'number';
        }
        if (control.type === 'checkbox') control.checked = Boolean(saved.value);
        else control.value = saved.value;
      }
    }
    document.querySelectorAll('[data-target-type]').forEach(updateGarminTargetPresentation);
  };
  const markGarminEditorDirty = () => {
    garminFormDirty = true; garminPreviewSnapshot = null; garminPreview.hidden = true;
  };
  const parsePaceMmSs = (value) => {
    const match = /^(\d{1,3}):(\d{2})$/.exec(String(value).trim());
    if (!match || Number(match[2]) > 59) throw new Error('invalid_prescription');
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const readEditorTarget = (prefix) => {
    const type = document.querySelector(`[data-target-type="${prefix}"]`)?.value || 'none';
    if (type === 'none') return { type: 'none' };
    const lower = document.querySelector(`[data-target-lower="${prefix}"]`)?.value || '';
    const upper = document.querySelector(`[data-target-upper="${prefix}"]`)?.value || '';
    if (type === 'heart_rate') {
      const low = Number(lower), high = Number(upper);
      if (!Number.isInteger(low) || !Number.isInteger(high) || low < 40 || high > 230 || low > high) throw new Error('invalid_prescription');
      return { type, mode: 'absolute', lower_bpm: low, upper_bpm: high };
    }
    const parsePace = (value) => parsePaceMmSs(value);
    const slower = parsePace(lower), faster = parsePace(upper);
    if (faster < 120 || slower > 1800 || faster > slower) throw new Error('invalid_prescription');
    return { type, unit: document.querySelector(`[data-target-type="${prefix}"]`)?.dataset.paceUnit || (getUserPreferences().distance_unit === 'mi' ? 'min_per_mile' : 'min_per_km'), slower_seconds: slower, faster_seconds: faster };
  };
  const readEditorEnd = (prefix) => {
    const type = document.querySelector(`[data-end-type="${prefix}"]`)?.value || 'time';
    const raw = document.querySelector(`[data-end-value="${prefix}"]`)?.value || '';
    const value = type === 'time' ? parseWorkoutDurationInput(raw).seconds
      : Math.round(Number(raw) * (getUserPreferences().distance_unit === 'mi' ? 1609.344 : 1000));
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) throw new Error('invalid_prescription');
    return { type, value };
  };
  const garminValidationSummary = document.getElementById('garminValidationSummary');
  const describedByTokens = (control) => (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  const clearGarminFieldError = (control) => {
    if (!control?.id) return;
    const error = document.getElementById(`${control.id}-error`);
    if (error) { error.hidden = true; error.textContent = ''; }
    control.removeAttribute('aria-invalid');
    const ids = describedByTokens(control).filter((id) => id !== error?.id);
    if (ids.length) control.setAttribute('aria-describedby', ids.join(' '));
    else control.removeAttribute('aria-describedby');
    garminValidationSummary.querySelector(`[data-validation-focus-id="${CSS.escape(control.id)}"]`)?.remove();
    refreshGarminValidationSummary();
  };
  const refreshGarminValidationSummary = () => {
    const list = garminValidationSummary.querySelector('ul');
    const links = [...list.querySelectorAll('button[data-validation-focus-id]')];
    if (!links.length) { garminValidationSummary.hidden = true; return; }
    garminValidationSummary.querySelector('p').textContent = garminText(links.length === 1 ? 'validationSummaryOne' : 'validationSummaryMany', { count: links.length });
    garminValidationSummary.hidden = false;
  };
  const setGarminFieldError = (control, key, params = {}) => {
    if (!control?.id) return;
    const error = document.getElementById(`${control.id}-error`);
    if (!error) return;
    error.textContent = garminText(key, params); error.hidden = false;
    control.setAttribute('aria-invalid', 'true');
    const ids = describedByTokens(control);
    if (!ids.includes(error.id)) ids.push(error.id);
    control.setAttribute('aria-describedby', ids.join(' '));
  };
  const garminFieldContext = (control) => {
    const block = control.closest('.garmin-editor-block');
    const blockTitle = block?.querySelector('legend')?.textContent.trim()
      || control.closest('.garmin-editor-section')?.querySelector('legend')?.textContent.trim()
      || garminText('workoutNameField');
    const fieldTitle = control.getAttribute('aria-label')
      || control.closest('label')?.querySelector('[data-end-label], [data-target-lower-label], [data-target-upper-label]')?.textContent.trim()
      || control.closest('label')?.textContent.trim()
      || garminText('workoutNameField');
    return `${blockTitle} — ${fieldTitle}`;
  };
  const clearGarminValidation = () => {
    document.querySelectorAll('#garminWorkoutEditor [data-validation-error], #garminWorkoutName-error').forEach((node) => { node.hidden = true; node.textContent = ''; });
    document.querySelectorAll('#garminPrescriptionForm [aria-invalid="true"]').forEach((control) => {
      const errorId = `${control.id}-error`;
      control.removeAttribute('aria-invalid');
      const ids = describedByTokens(control).filter((id) => id !== errorId);
      if (ids.length) control.setAttribute('aria-describedby', ids.join(' ')); else control.removeAttribute('aria-describedby');
    });
    document.querySelectorAll('#garminWorkoutEditor [aria-invalid="true"]').forEach((control) => {
      control.removeAttribute('aria-invalid');
      const ids = describedByTokens(control).filter((id) => id !== 'garminPrescriptionError');
      if (ids.length) control.setAttribute('aria-describedby', ids.join(' ')); else control.removeAttribute('aria-describedby');
    });
    garminValidationSummary.querySelector('ul').replaceChildren();
    garminValidationSummary.hidden = true;
  };
  const validateGarminEditorFields = () => {
    clearGarminValidation();
    const invalid = [];
    const add = (control, key, params) => { setGarminFieldError(control, key, params); invalid.push({ control, key }); };
    const name = document.getElementById('garminWorkoutName');
    const nameValue = name.value.trim();
    if (!nameValue) add(name, 'nameRequired');
    else if (nameValue.length > 32 || !/^[\p{L}\p{N}\p{M} _.,'’()&+-]+$/u.test(nameValue)) add(name, 'nameInvalid');

    for (const select of document.querySelectorAll('#garminWorkoutEditor [data-end-type]:not(:disabled)')) {
      const input = document.querySelector(`[data-end-value="${select.dataset.endType}"]`);
      if (!input || input.disabled) continue;
      if (select.value === 'time') {
        try { input.value = parseWorkoutDurationInput(input.value).normalized; }
        catch (error) {
          const key = ['duration_required', 'duration_positive', 'duration_format', 'duration_seconds_range', 'duration_too_long'].includes(error.message) ? error.message : 'duration_format';
          add(input, key, { limit: garminText('durationLimit'), actual: input.value.trim() || garminText('durationEmptyValue') });
        }
      } else {
        const raw = input.value.trim();
        const amount = raw === '' ? Number.NaN : Number(raw);
        const unit = getUserPreferences().distance_unit === 'mi' ? 'mi' : 'km';
        const meters = amount * (unit === 'mi' ? 1609.344 : 1000);
        if (raw === '') add(input, 'distanceRequired');
        else if (!Number.isFinite(amount)) add(input, 'distanceFormat');
        else if (amount <= 0) add(input, 'distancePositive');
        else if (!Number.isSafeInteger(Math.round(meters)) || Math.round(meters) > 100000) add(input, 'distanceTooLong', { actual: `${raw} ${unit}`, limit: unit === 'mi' ? '62.14 mi' : '100 km' });
      }
    }
    for (const select of document.querySelectorAll('#garminWorkoutEditor [data-target-type]:not(:disabled)')) {
      if (select.value === 'none') continue;
      const prefix = select.dataset.targetType;
      const lower = document.querySelector(`[data-target-lower="${prefix}"]`);
      const upper = document.querySelector(`[data-target-upper="${prefix}"]`);
      if (select.value === 'heart_rate') {
        const lo = lower.value.trim() === '' ? Number.NaN : Number(lower.value);
        const hi = upper.value.trim() === '' ? Number.NaN : Number(upper.value);
        if (!Number.isInteger(lo)) add(lower, 'heartRateRequired');
        else if (lo < 40 || lo > 230) add(lower, 'heartRateRange');
        if (!Number.isInteger(hi)) add(upper, 'heartRateRequired');
        else if (hi < 40 || hi > 230) add(upper, 'heartRateRange');
        else if (Number.isInteger(lo) && lo > hi) add(upper, 'heartRateOrder');
      } else {
        let slower; let faster;
        try { slower = parsePaceMmSs(lower.value); } catch { add(lower, lower.value.trim() ? 'paceFormat' : 'paceRequired'); }
        try { faster = parsePaceMmSs(upper.value); } catch { add(upper, upper.value.trim() ? 'paceFormat' : 'paceRequired'); }
        if (Number.isInteger(slower) && (slower < 120 || slower > 1800)) add(lower, 'paceRange');
        if (Number.isInteger(faster) && (faster < 120 || faster > 1800)) add(upper, 'paceRange');
        else if (Number.isInteger(slower) && Number.isInteger(faster) && faster > slower) add(upper, 'paceOrder');
      }
    }
    for (const input of document.querySelectorAll('#garminRunBlocks [data-repetitions]')) {
      const count = Number(input.value);
      if (!Number.isInteger(count) || count < 2 || count > 20) add(input, 'repetitionRange');
    }
    if (!invalid.length) return invalid;
    const list = garminValidationSummary.querySelector('ul');
    for (const { control } of invalid) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.validationFocusId = control.id;
      button.textContent = garminFieldContext(control); list.append(button);
    }
    refreshGarminValidationSummary();
    return invalid;
  };
  const showGarminContractDiagnostic = (diagnostic) => {
    const reason = diagnostic?.reason || 'malformed_structure';
    const messages = {
      step_position_invalid: diagnostic?.kind === 'recovery' ? 'stepPositionInvalid' : 'stagePositionInvalid',
      step_duration_limit: 'stepDurationLimit',
      total_duration_limit: 'totalDurationLimit',
      distance_limit: diagnostic?.field === 'total_distance' ? 'totalDistanceLimit' : 'stepDistanceLimit',
      expanded_steps_limit: 'expandedStepsLimit',
      repetition_count_invalid: 'repetitionRange',
      target_invalid: 'targetInvalid',
      missing_running_step: 'missingRunningStep',
      malformed_structure: 'malformedStructure',
    };
    const block = diagnostic?.step_id
      ? document.querySelector(`#garminRunBlocks [data-block-id="${CSS.escape(diagnostic.step_id)}"]`)
      : null;
    const displayDistance = (meters) => getUserPreferences().distance_unit === 'mi'
      ? `${(meters / 1609.344).toLocaleString(undefined, { maximumFractionDigits: 2 })} mi`
      : `${(meters / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km`;
    const message = garminText(messages[reason] || 'malformedStructure', {
      actual: diagnostic?.unit === 'seconds' ? formatDuration(diagnostic.actual) : diagnostic?.unit === 'meters' ? displayDistance(diagnostic.actual) : diagnostic?.actual,
      maximum: diagnostic?.unit === 'seconds' ? formatDuration(diagnostic.maximum) : diagnostic?.unit === 'meters' ? displayDistance(diagnostic.maximum) : diagnostic?.maximum,
    });
    const prescriptionError = document.getElementById('garminPrescriptionError');
    prescriptionError.textContent = block ? `${block.querySelector('legend')?.textContent.trim() || garminText('runBlock')}: ${message}` : message;
    prescriptionError.hidden = false;
    if (block) {
      block.setAttribute('aria-invalid', 'true');
      block.setAttribute('aria-describedby', 'garminPrescriptionError');
      garminValidationSummary.querySelector('p').textContent = garminText('validationSummaryOne');
      const item = document.createElement('li');
      item.textContent = prescriptionError.textContent;
      garminValidationSummary.querySelector('ul').replaceChildren(item);
      garminValidationSummary.hidden = false;
      block.querySelector('legend')?.focus();
      block.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      garminValidationSummary.hidden = false;
      garminValidationSummary.querySelector('p').textContent = message;
      garminValidationSummary.querySelector('ul').replaceChildren();
      prescriptionError.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };
  garminValidationSummary.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-validation-focus-id]');
    if (!button) return;
    const control = document.getElementById(button.dataset.validationFocusId);
    control?.focus(); control?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  const fillGarminPrescription = (value) => {
    if (!value) return;
    garminOriginalPrescription = structuredClone(value);
    document.getElementById('garminWorkoutName').value = value.name;
    const warmup = value.steps.find((step) => step.kind === 'warmup');
    const cooldown = value.steps.find((step) => step.kind === 'cooldown');
    garminEditorSteps = value.version >= 2 ? structuredClone(value.steps) : legacyStepsToV2(value);
    garminWarmupDraftEnabled = Boolean(warmup);
    garminCooldownDraftEnabled = Boolean(cooldown);
    garminOptionalDraft = { warmup: warmup ? structuredClone(warmup) : null, cooldown: cooldown ? structuredClone(cooldown) : null };
    renderGarminEditor();
    garminFormDirty = false;
  };
  const legacyStepsToV2 = (value) => value.steps.flatMap((step) => {
    if (step.kind === 'warmup' || step.kind === 'cooldown') return [{ ...structuredClone(step), kind: step.kind }];
    if (step.kind === 'repeat') return [{ ...structuredClone(step), kind: 'repeat', recovery: step.recovery?.end?.value > 0 ? structuredClone(step.recovery) : undefined }];
    if (step.kind === 'run') return [structuredClone(step)];
    return [];
  });
  const garminPrescriptionFromForm = () => {
    const reject = (reason, details = {}) => {
      const error = new Error('invalid_prescription');
      error.diagnostic = { reason, ...details };
      throw error;
    };
    if (!garminFormDirty && garminOriginalPrescription) return structuredClone(garminOriginalPrescription);
    if (garminOriginalPrescription?.steps.some((step) => step.kind === 'open')) throw new Error('unsupported');
    if (garminEditorSteps.length === 0) reject('malformed_structure');
    const steps = [];
    const warmToggle = document.getElementById('garminWarmupEnabled').checked;
    const coolToggle = document.getElementById('garminCooldownEnabled').checked;
    const originalWarm = garminEditorSteps.find((step) => step.kind === 'warmup');
    const originalCool = garminEditorSteps.find((step) => step.kind === 'cooldown');
    if (warmToggle) steps.push({ id: 'warmup', kind: 'warmup', end: readEditorEnd('warmup'), target: readEditorTarget('warmup') });
    const runRows = [...document.querySelectorAll('#garminRunBlocks .garmin-editor-block')];
    if (!runRows.length) reject('missing_running_step');
    runRows.forEach((row, index) => {
      const original = garminEditorSteps.filter((step) => ['run', 'repeat', 'recovery'].includes(step.kind))[index];
      const id = original?.id || `run-${index + 1}`;
      const prefix = `step-${id}`;
      if (original?.kind === 'repeat') {
        const count = Number(row.querySelector(`[data-repetitions="${id}"]`)?.value);
        const recovery = { end: readEditorEnd(`${prefix}-recovery`), target: readEditorTarget(`${prefix}-recovery-target`) };
        steps.push({ id, kind: 'repeat', repetitions: count, interval: { end: readEditorEnd(prefix), target: readEditorTarget(`${prefix}-target`) }, recovery, skip_last_rest_step: Boolean(row.querySelector(`[data-skip-last="${id}"]`)?.checked) });
      } else {
        steps.push({ id, kind: original?.kind === 'recovery' ? 'recovery' : 'run', end: readEditorEnd(prefix), target: readEditorTarget(`${prefix}-target`) });
      }
    });
    if (coolToggle) steps.push({ id: 'cooldown', kind: 'cooldown', end: readEditorEnd('cooldown'), target: readEditorTarget('cooldown') });
    let expanded = 0, totalSeconds = 0, totalMeters = 0;
    for (const step of steps) {
      if (step.kind === 'repeat') {
        if (!Number.isInteger(step.repetitions) || step.repetitions < 2 || step.repetitions > 20) reject('repetition_count_invalid', { step_id: step.id, actual: step.repetitions, minimum: 2, maximum: 20 });
        const rests = step.repetitions - (step.skip_last_rest_step ? 1 : 0);
        expanded += 1 + step.repetitions + rests;
        if (step.interval.end.type === 'time') totalSeconds += step.interval.end.value * step.repetitions;
        else totalMeters += step.interval.end.value * step.repetitions;
        if (step.recovery) {
          if (step.recovery.end.type === 'time') totalSeconds += step.recovery.end.value * rests;
          else totalMeters += step.recovery.end.value * rests;
        }
      } else {
        expanded += 1;
        if (step.end.type === 'time') totalSeconds += step.end.value;
        else totalMeters += step.end.value;
      }
    }
    let seenRunningStep = false;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (step.kind === 'run' || step.kind === 'repeat') seenRunningStep = true;
      if (step.kind === 'recovery' && !seenRunningStep) reject('step_position_invalid', { step_id: step.id, step_index: index, kind: 'recovery', requirement: 'after_running_step' });
    }
    if (expanded > 50) reject('expanded_steps_limit', { actual: expanded, maximum: 50 });
    if (totalSeconds > 86400) reject('total_duration_limit', { actual: totalSeconds, maximum: 86400, unit: 'seconds' });
    if (totalMeters > 100000) reject('distance_limit', { field: 'total_distance', actual: totalMeters, maximum: 100000, unit: 'meters' });
    if (!steps.some((step) => step.kind === 'run' || step.kind === 'repeat')) reject('missing_running_step');
    return { version: 3, sport: 'running', name: document.getElementById('garminWorkoutName').value.trim(), steps };
  };
  const garminExpandedStepCount = (steps) => steps.reduce((total, step) => {
    if (step.kind !== 'repeat') return total + 1;
    const raw = document.querySelector(`[data-repetitions="${CSS.escape(step.id)}"]`)?.value;
    const parsed = Number(raw ?? step.repetitions);
    const repetitions = Number.isInteger(parsed) && parsed >= 2 && parsed <= 20 ? parsed : 20;
    return total + 1 + repetitions + (step.recovery ? repetitions - (step.skip_last_rest_step ? 1 : 0) : 0);
  }, 0);
  const showGarminEditorActionMessage = (key) => {
    const message = document.getElementById('garminEditorActionStatus');
    message.textContent = garminText(key);
    message.hidden = false;
  };
  const canAddGarminStep = (steps) => garminExpandedStepCount(steps) < 50;
  const alignGarminRunOrderFromDom = () => {
    const ids = [...document.querySelectorAll('#garminRunBlocks .garmin-editor-block')].map((block) => block.dataset.blockId);
    const stepsById = new Map(garminEditorSteps.map((step) => [step.id, step]));
    const ordered = ids.map((id) => stepsById.get(id)).filter(Boolean);
    const nonRun = garminEditorSteps.filter((step) => !['run', 'repeat', 'recovery'].includes(step.kind));
    garminEditorSteps = [...nonRun.filter((step) => step.kind === 'warmup'), ...ordered, ...nonRun.filter((step) => step.kind !== 'warmup')];
  };
  const captureBlockDraft = (id) => {
    const block = document.querySelector(`#garminRunBlocks [data-block-id="${CSS.escape(id)}"]`);
    return block ? [...block.querySelectorAll('input,select')].map((control) => ({
      key: ['data-end-value', 'data-end-type', 'data-target-type', 'data-target-lower', 'data-target-upper', 'data-repetitions', 'data-skip-last']
        .map((attribute) => control.hasAttribute(attribute) ? `${attribute}:${control.getAttribute(attribute)}` : null).find(Boolean),
      value: control.type === 'checkbox' ? control.checked : control.value,
    })).filter((item) => item.key) : [];
  };
  const restoreDuplicatedBlockDraft = (sourceId, copyId, controls) => {
    for (const item of controls) {
      const [attribute, rawValue] = item.key.split(/:(.*)/s).slice(0, 2);
      const sourcePrefix = `step-${sourceId}`;
      const copyPrefix = `step-${copyId}`;
      const value = rawValue.startsWith(sourcePrefix) ? `${copyPrefix}${rawValue.slice(sourcePrefix.length)}` : copyId;
      const control = [...document.querySelectorAll(`#garminRunBlocks [${attribute}]`)].find((element) => element.getAttribute(attribute) === value);
      if (control) {
        if (attribute === 'data-target-lower' || attribute === 'data-target-upper') {
          const targetSelect = [...document.querySelectorAll('#garminRunBlocks [data-target-type]')].find((candidate) =>
            document.querySelector(`[data-target-fields="${candidate.dataset.targetType}"] [${attribute}="${CSS.escape(value)}"]`));
          control.type = targetSelect?.value === 'pace' ? 'text' : 'number';
        }
        control.type === 'checkbox' ? control.checked = Boolean(item.value) : control.value = item.value;
      }
    }
    document.querySelectorAll(`#garminRunBlocks [data-block-id="${CSS.escape(copyId)}"] [data-target-type]`).forEach(updateGarminTargetPresentation);
  };
  const addGarminEditorStep = (kind) => {
    alignGarminRunOrderFromDom();
    if (!canAddGarminStep(garminEditorSteps)) { showGarminEditorActionMessage('editorLimit'); return; }
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
    const step = { id, kind, end: { type: 'time', value: kind === 'recovery' ? '' : 600 }, target: { type: 'none' } };
    const cooldownIndex = garminEditorSteps.findIndex((item) => item.kind === 'cooldown');
    garminEditorSteps.splice(cooldownIndex < 0 ? garminEditorSteps.length : cooldownIndex, 0, step);
    document.getElementById('garminEditorActionStatus').hidden = true;
    renderGarminEditor(true); markGarminEditorDirty();
    document.querySelector(`[data-end-value="step-${id}"]`)?.focus();
  };
  document.getElementById('garminAddRunBlock').addEventListener('click', () => addGarminEditorStep('run'));
  document.getElementById('garminAddRecoveryBlock').addEventListener('click', () => addGarminEditorStep('recovery'));
  document.getElementById('garminAddRepeatBlock').addEventListener('click', () => {
    alignGarminRunOrderFromDom();
    const repeat = { id: `repeat-${crypto.randomUUID().slice(0, 8)}`, kind: 'repeat', repetitions: 2, skip_last_rest_step: true,
      interval: { end: { type: 'time', value: 180 }, target: { type: 'none' } }, recovery: { end: { type: 'time', value: '' }, target: { type: 'none' } } };
    if (!canAddGarminStep([...garminEditorSteps, repeat])) { showGarminEditorActionMessage('editorLimit'); return; }
    const id = repeat.id;
    const cooldownIndex = garminEditorSteps.findIndex((item) => item.kind === 'cooldown');
    garminEditorSteps.splice(cooldownIndex < 0 ? garminEditorSteps.length : cooldownIndex, 0, repeat);
    document.getElementById('garminEditorActionStatus').hidden = true;
    renderGarminEditor(true); markGarminEditorDirty();
    document.querySelector(`[data-end-value="step-${id}"]`)?.focus();
  });
  document.getElementById('garminWarmupEnabled').addEventListener('change', (event) => { garminWarmupDraftEnabled = event.target.checked; renderGarminEditor(true); markGarminEditorDirty(); });
  document.getElementById('garminCooldownEnabled').addEventListener('change', (event) => { garminCooldownDraftEnabled = event.target.checked; renderGarminEditor(true); markGarminEditorDirty(); });
  document.getElementById('garminRunBlocks').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-editor-action]');
    if (!button || button.disabled) return;
    alignGarminRunOrderFromDom();
    const index = garminEditorSteps.findIndex((step) => step.id === button.dataset.id);
    if (index < 0) return;
    const action = button.dataset.editorAction;
    let focusId = garminEditorSteps[index].id;
    let convertedDraft = null;
    let convertedIds = [];
    if (action === 'remove') {
      const mainBefore = garminEditorSteps.filter((step) => ['run', 'repeat', 'recovery'].includes(step.kind));
      const mainIndex = mainBefore.findIndex((step) => step.id === focusId);
      garminEditorSteps.splice(index, 1);
      const mainAfter = garminEditorSteps.filter((step) => ['run', 'repeat', 'recovery'].includes(step.kind));
      focusId = mainAfter[Math.min(mainIndex, mainAfter.length - 1)]?.id || null;
    } else if (action === 'convert-repeat') {
      const old = garminEditorSteps[index];
      if (old.kind !== 'repeat' || old.recovery) return;
      convertedDraft = captureBlockDraft(old.id);
      const count = Number(document.querySelector(`[data-repetitions="${CSS.escape(old.id)}"]`)?.value || old.repetitions);
      if (!Number.isInteger(count) || count < 2 || count > 20 || !canAddGarminStep([...garminEditorSteps.filter((step) => step.id !== old.id), ...Array.from({ length: count }, () => ({ kind: 'run' }))])) {
        showGarminEditorActionMessage('editorLimit'); return;
      }
      const runs = Array.from({ length: count }, (_, runIndex) => ({ id: runIndex === 0 ? old.id : `run-${crypto.randomUUID().slice(0, 8)}`,
        kind: 'run', end: structuredClone(old.interval.end), target: structuredClone(old.interval.target) }));
      garminEditorSteps.splice(index, 1, ...runs);
      convertedIds = runs.map((run) => run.id);
      focusId = runs[0].id;
    } else if (action === 'duplicate') {
      const clone = structuredClone(garminEditorSteps[index]); clone.id = `${clone.kind}-${crypto.randomUUID().slice(0, 8)}`;
      if (clone.kind === 'repeat') {
        const rawRepetitions = Number(document.querySelector(`[data-repetitions="${CSS.escape(button.dataset.id)}"]`)?.value);
        clone.repetitions = Number.isInteger(rawRepetitions) && rawRepetitions >= 2 && rawRepetitions <= 20 ? rawRepetitions : 20;
        clone.skip_last_rest_step = Boolean(document.querySelector(`[data-skip-last="${CSS.escape(button.dataset.id)}"]`)?.checked);
      }
      if (!canAddGarminStep([...garminEditorSteps, clone])) { showGarminEditorActionMessage('editorLimit'); return; }
      garminEditorSteps.splice(index + 1, 0, clone);
      focusId = clone.id;
    } else if (action === 'up' || action === 'down') {
      const mainIndexes = garminEditorSteps.map((step, stepIndex) => ['run', 'repeat', 'recovery'].includes(step.kind) ? stepIndex : -1).filter((stepIndex) => stepIndex >= 0);
      const mainIndex = mainIndexes.indexOf(index);
      const nextMainIndex = mainIndex + (action === 'up' ? -1 : 1);
      if (mainIndex >= 0 && nextMainIndex >= 0 && nextMainIndex < mainIndexes.length) {
        const next = mainIndexes[nextMainIndex]; [garminEditorSteps[index], garminEditorSteps[next]] = [garminEditorSteps[next], garminEditorSteps[index]];
      }
    } else return;
    document.getElementById('garminEditorActionStatus').hidden = true;
    const activeId = focusId;
    renderGarminEditor(true); markGarminEditorDirty();
    if (action === 'duplicate') restoreDuplicatedBlockDraft(button.dataset.id, focusId, captureBlockDraft(button.dataset.id));
    if (action === 'convert-repeat') for (const id of convertedIds.slice(1)) restoreDuplicatedBlockDraft(convertedIds[0], id, convertedDraft);
    const block = activeId ? document.querySelector(`#garminRunBlocks [data-block-id="${CSS.escape(activeId)}"]`) : null;
    if (block) {
      const focusableAction = block.querySelector('button[data-editor-action]:not(:disabled)');
      (focusableAction || block.querySelector('legend'))?.focus();
    } else document.getElementById('garminAddRunBlock').focus();
  });
  garminPrescriptionForm.addEventListener('input', (event) => {
    clearGarminFieldError(event.target);
    if (garminOperationMessageKey === 'invalidFields') { garminOperationMessageKey = null; garminOperationStatus.textContent = ''; }
    document.getElementById('garminPrescriptionError').hidden = true;
    if (event.target.id === 'garminWorkoutName' || event.target.closest('#garminWorkoutEditor')) markGarminEditorDirty();
  });
  garminPrescriptionForm.addEventListener('focusout', (event) => {
    const input = event.target.closest('[data-end-value]');
    if (!input || document.querySelector(`[data-end-type="${input.dataset.endValue}"]`)?.value !== 'time') return;
    try { input.value = parseWorkoutDurationInput(input.value).normalized; } catch { /* Keep invalid text visible for correction. */ }
  });
  document.querySelectorAll('[aria-hidden="true"] [required]').forEach((control) => { control.required = false; control.disabled = true; });
  renderGarminEditor();
  const renderGarminOperation = (operation) => {
    const sameStoredState = garminCurrentOperation?.operation_id === operation.operation_id
      && garminCurrentOperation?.status === operation.status && garminCurrentOperation?.stage === operation.stage;
    if (!sameStoredState) garminStatusRetryAvailable = false;
    if (garminOperationId !== operation.operation_id) {
      clearTimeout(garminOperationTimer);
      garminOperationController?.abort();
      garminOperationController = null;
      garminOperationId = operation.operation_id;
      garminOperationRead += 1;
    }
    garminCurrentOperation = operation;
    const disconnectBlocked = garminOperationNeedsResolution(operation);
    garminDisconnectButton.disabled = disconnectBlocked;
    garminDisconnectHelp.hidden = !disconnectBlocked;
    const read = ++garminOperationRead;
    const active = ['publishing', 'workout_created', 'scheduling'].includes(operation.status);
    const unresolved = garminOperationNeedsResolution(operation);
    const hasWorkout = Boolean(operation.workout_id);
    const scheduleStage = ['schedule', 'schedule_reconciliation'].includes(operation.stage);
    const rescheduleStage = ['reschedule', 'reschedule_reconciliation'].includes(operation.stage);
    const updateStage = ['update', 'update_confirmation', 'update_reconciliation'].includes(operation.stage);
    let messageKey = 'failed';
    if (operation.status === 'scheduled') messageKey = 'scheduled';
    else if (operation.status === 'outdated') messageKey = 'outdated';
    else if (active && hasWorkout && scheduleStage) messageKey = operation.action === 'update' ? 'workoutUpdatedScheduling' : 'workoutCreatedScheduling';
    else if (active && hasWorkout && rescheduleStage) messageKey = operation.action === 'update' ? 'workoutUpdatedRescheduling' : 'rescheduling';
    else if (active && updateStage) messageKey = 'updating';
    else if (active && rescheduleStage) messageKey = 'rescheduling';
    else if (active) messageKey = 'publishing';
    else if (hasWorkout && scheduleStage && operation.status === 'reauth_required') messageKey = operation.action === 'update' ? 'workoutUpdatedAuthRequired' : 'workoutCreatedAuthRequired';
    else if (hasWorkout && scheduleStage && operation.status === 'outcome_unknown') messageKey = operation.action === 'update' ? 'workoutUpdatedScheduleUncertain' : 'workoutCreatedScheduleUncertain';
    else if (hasWorkout && scheduleStage && operation.status === 'failed') messageKey = operation.error_code === 'rate_limited'
      ? operation.action === 'update' ? 'workoutUpdatedScheduleRateLimited' : 'workoutCreatedScheduleRateLimited'
      : operation.action === 'update' ? 'workoutUpdatedScheduleFailed' : 'workoutCreatedScheduleFailed';
    else if (hasWorkout && rescheduleStage && operation.status === 'reauth_required') messageKey = 'workoutUpdatedAuthRequired';
    else if (hasWorkout && rescheduleStage && operation.status === 'outcome_unknown') messageKey = 'workoutUpdatedRescheduleUncertain';
    else if (hasWorkout && rescheduleStage && operation.status === 'failed') messageKey = operation.error_code === 'rate_limited' ? 'workoutUpdatedRescheduleRateLimited' : 'workoutUpdatedRescheduleFailed';
    else if (operation.status === 'outcome_unknown') messageKey = updateStage ? 'updateUncertain' : 'uncertain';
    else if (operation.status === 'reauth_required') messageKey = 'authError';
    else if (operation.status === 'failed') messageKey = operation.error_code === 'unsupported' ? 'unsupported'
      : operation.error_code === 'invalid_payload' || operation.error_code === 'invalid_prescription' ? 'structureRejected'
        : operation.error_code === 'rate_limited' ? 'rateLimited'
          : operation.error_code === 'auth_required' ? 'authError'
            : operation.error_code === 'unavailable' ? 'connectorUnavailableResult'
              : ['connector_auth_failed', 'connector_configuration_error', 'connector_service_error'].includes(operation.error_code) ? 'connectError'
              : operation.action === 'update' ? 'updateFailed'
                : operation.action === 'reschedule' ? 'rescheduleFailed' : 'publishFailed';
    if (sameStoredState && garminStatusRetryAvailable) messageKey = 'statusReadError';
    setGarminOperationMessage(messageKey);
    garminOperationStatus.dataset.operationId = operation.operation_id;
    garminOperationRetry.hidden = !(garminDispatchUncertain || garminStatusRetryAvailable);
    garminReconcileButton.hidden = !['outcome_unknown', 'reauth_required', 'failed', 'workout_created'].includes(operation.status);
    garminReconcileButton.disabled = garminPending;
    // Keep a single source of truth for editing and mutation controls. An
    // uncertain or partially completed operation holds the saved snapshot
    // until reconciliation, because editing could replace its recovery data.
    garminEditStructure.disabled = garminPending || unresolved;
    garminEditorView.inert = unresolved;
    const saveButton = document.getElementById('garminPrescriptionSave');
    if (saveButton) saveButton.disabled = garminPending || unresolved;
    if (garminPreviewModel) renderGarminPreview(garminPreviewModel);
    if (active && !garminOperationTimer && !garminOperationController) {
      const operationId = operation.operation_id;
      garminOperationTimer = window.setTimeout(async () => {
        garminOperationTimer = null;
        const controller = new AbortController();
        garminOperationController = controller;
        try {
          const latest = await garminFetch(`/api/garmin/operations/${operationId}`, { signal: controller.signal });
          if (read === garminOperationRead && operationId === garminOperationId
              && garminCurrentOperation?.operation_id === operationId
              && ['publishing', 'workout_created', 'scheduling'].includes(garminCurrentOperation.status)) renderGarminOperation(latest.operation);
        } catch {
          if (read === garminOperationRead && operationId === garminOperationId) {
            setGarminOperationMessage('statusReadError');
            garminStatusRetryAvailable = true;
            garminOperationRetry.hidden = false;
          }
        } finally {
          if (garminOperationController === controller) garminOperationController = null;
          if (garminCurrentOperation?.operation_id === operationId
              && ['publishing', 'workout_created', 'scheduling'].includes(garminCurrentOperation.status)
              && !garminOperationTimer && !garminOperationController) renderGarminOperation(garminCurrentOperation);
        }
      }, 1800);
    }
  };
  const renderGarminPreview = (preview) => {
    garminPreviewModel = preview;
    if (!preview) return;
    garminPreviewSteps.replaceChildren();
    const distanceUnit = getUserPreferences().distance_unit === 'mi' ? 'mi' : 'km';
    document.getElementById('garminPreviewName').textContent = preview.name || '';
    const deviceContext = document.getElementById('garminPreviewDeviceContext');
    deviceContext.hidden = garminDestinationNames.length === 0;
    document.getElementById('garminPreviewDestination').textContent = garminDestinationNames.join(', ');
    const humanDuration = (seconds) => {
      const total = Math.max(0, Math.round(Number(seconds) || 0));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const remainingSeconds = total % 60;
      const parts = [];
      if (hours) parts.push(garminText('durationHours', { count: hours }));
      if (minutes) parts.push(garminText('durationMinutes', { count: minutes }));
      if (remainingSeconds) parts.push(garminText('durationSeconds', { count: remainingSeconds }));
      return parts.length ? parts.join(' ') : garminText('durationZero');
    };
    const detailFor = (end) => end?.type === 'time' ? humanDuration(end.value)
      : end?.type === 'distance' ? formatDistance(end.value / 1000, distanceUnit)
        : end?.type === 'open' ? garminText('openStep') : garminText('unsupported');
    const targetFor = (target) => formatGarminTarget(target, distanceUnit);
    const appendPart = (container, label, block, count = null) => {
      const part = document.createElement('div');
      part.className = 'garmin-review-part';
      const heading = document.createElement('span');
      heading.className = 'garmin-review-part-title';
      heading.textContent = count === null ? label || '' : garminText(count === 1 ? 'recoveryCountOne' : 'recoveryCount', { count, label });
      const value = document.createElement('strong');
      value.className = 'garmin-review-step-value';
      value.textContent = detailFor(block.end);
      const target = document.createElement('span');
      target.className = block.target?.type === 'none' ? 'garmin-review-target garmin-review-target-muted' : 'garmin-review-target';
      target.textContent = garminText('targetLine', { target: targetFor(block.target) });
      if (label !== null || count !== null) part.append(heading);
      part.append(value, target);
      container.append(part);
    };
    preview.steps.forEach((step, index) => {
      const li = document.createElement('li');
      li.className = `garmin-review-step garmin-review-step-${step.kind}`;
      const marker = document.createElement('span');
      marker.className = 'garmin-review-order';
      marker.setAttribute('aria-hidden', 'true');
      marker.textContent = String(index + 1);
      const content = document.createElement('div');
      content.className = 'garmin-review-step-content';
      const heading = document.createElement('h4');
      heading.textContent = garminText(step.kind === 'repeat' ? 'repeatName' : `${step.kind}Name`, { count: step.repetitions });
      content.append(heading);
      if (step.kind === 'repeat') {
        const run = step.interval || { end: step.end, target: step.target };
        appendPart(content, garminText('intervalPart'), run);
        if (step.recovery) {
          const recoveryCount = step.skip_last_rest_step ? Math.max(0, step.repetitions - 1) : step.repetitions;
          appendPart(content, garminText('recoveryPart'), step.recovery, recoveryCount);
          const policy = document.createElement('p');
          policy.className = 'garmin-review-policy';
          policy.textContent = garminText(step.skip_last_rest_step ? 'noFinalRecovery' : 'finalRecoveryIncluded');
          content.append(policy);
        }
      } else appendPart(content, null, step);
      li.append(marker, content);
      garminPreviewSteps.append(li);
    });
    const summary = document.getElementById('garminPreviewTotal');
    summary.replaceChildren();
    const addMetric = (labelKey, value, helpKey = null) => {
      const item = document.createElement('div'); item.className = 'garmin-review-metric';
      const label = document.createElement('span'); label.className = 'garmin-review-metric-label'; label.textContent = garminText(labelKey);
      const amount = document.createElement('strong'); amount.textContent = value; item.append(label, amount);
      if (helpKey) { const help = document.createElement('span'); help.className = 'garmin-review-metric-help'; help.textContent = garminText(helpKey); item.append(help); }
      summary.append(item);
    };
    if (preview.duration_complete && preview.estimated_duration_seconds !== null) addMetric('totalDurationLabel', humanDuration(preview.estimated_duration_seconds));
    else if (preview.total_time_seconds > 0) addMetric('definedTimeLabel', humanDuration(preview.total_time_seconds), 'partialTotalHelp');
    if (preview.distance_complete && preview.total_distance_meters > 0) addMetric('totalDistanceLabel', formatDistance(preview.total_distance_meters / 1000, distanceUnit));
    else if (preview.total_distance_meters > 0) addMetric('definedDistanceLabel', formatDistance(preview.total_distance_meters / 1000, distanceUnit), 'partialTotalHelp');
    addMetric('stageCountLabel', garminText('stageCount', { count: preview.expanded_step_count ?? preview.steps.length }));
    document.getElementById('garminScheduleDate').textContent = formatLocalizedDate(preview.date || training.dia, i18n.language);
    const canUpdate = ['scheduled', 'outdated'].includes(garminCurrentOperation?.status)
      && garminCurrentOperation.connection_generation === garminConnectionGeneration
      && garminCurrentOperation.workout_id && garminCurrentOperation.occurrence_id;
    const operationNeedsReconciliation = garminCurrentOperation
      && garminCurrentOperation.connection_generation === garminConnectionGeneration
      && ['publishing', 'workout_created', 'scheduling', 'outcome_unknown', 'reauth_required', 'failed'].includes(garminCurrentOperation.status);
    garminUpdateButton.hidden = !canUpdate || garminCurrentOperation.prescription_revision === garminSavedRevision;
    garminRescheduleButton.hidden = !canUpdate || garminCurrentOperation.prescription_revision !== garminSavedRevision
      || garminCurrentOperation.scheduled_date === (preview.date || training.dia);
    document.getElementById('garminPublishButton').hidden = Boolean(canUpdate || operationNeedsReconciliation);
    const dateChanged = Boolean(canUpdate && garminCurrentOperation.scheduled_date !== (preview.date || training.dia));
    const helpKey = operationNeedsReconciliation ? 'reconcileActionHelp'
      : canUpdate && !dateChanged && garminCurrentOperation.prescription_revision === garminSavedRevision ? 'alreadyScheduledHelp'
      : !garminCurrentOperation || !canUpdate ? 'publishActionHelp'
      : dateChanged && garminCurrentOperation.prescription_revision !== garminSavedRevision ? 'updateAndRescheduleActionHelp'
        : dateChanged ? 'rescheduleActionHelp' : 'updateActionHelp';
    const unresolved = garminPending || garminDispatchUncertain || garminOperationNeedsResolution();
    const actionHelp = document.getElementById('garminActionHelp');
    actionHelp.textContent = unresolved ? '' : garminText(helpKey);
    actionHelp.hidden = unresolved;
    const actionButtons = [document.getElementById('garminPublishButton'), garminUpdateButton, garminRescheduleButton];
    actionButtons.forEach((button) => { button.disabled = !garminConnected || garminStatusUnavailable || garminPending || unresolved || !garminPreviewSnapshot; });
    garminEditStructure.disabled = garminPending || unresolved;
    garminReconcileButton.disabled = garminPending;
    garminOperationRetry.hidden = !(garminDispatchUncertain || garminStatusRetryAvailable);
    garminPreview.hidden = !garminPreviewSnapshot || garminFormDirty || !garminEditorView.hidden;
  };
  document.addEventListener('app:languagechange', () => {
    setGarminConnectionMessage(garminConnectionMessage);
    const destination = document.getElementById('garminDestination');
    destination.textContent = garminDestinationNames.length ? `${garminText('accountDevice')}: ${garminDestinationNames.join(', ')}` : '';
    if (garminCurrentOperation) renderGarminOperation(garminCurrentOperation);
    else if (garminOperationMessageKey) setGarminOperationMessage(garminOperationMessageKey);
    if (garminPreviewModel) renderGarminPreview(garminPreviewModel);
    renderGarminEditor(true);
  });
  function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  function paceText(seconds, unit = 'min_per_km') {
    const preferred = getUserPreferences().distance_unit === 'mi' ? 'mi' : 'km';
    const source = unit === 'min_per_mile' ? 'mi' : 'km';
    let converted = Number(seconds);
    if (source !== preferred) converted = preferred === 'mi' ? converted / KM_TO_MILES : converted * KM_TO_MILES;
    const total = Math.round(converted);
    const suffix = preferred;
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} min/${suffix}`;
  }
  function formatGarminTarget(target, distanceUnit) {
    if (!target || target.type === 'none') return garminText('noTarget');
    if (target.type === 'heart_rate') return `${target.lower_bpm}–${target.upper_bpm} bpm`;
    if (target.type === 'pace') return `${paceText(target.faster_seconds, target.unit)}–${paceText(target.slower_seconds, target.unit)}`;
    return garminText('unsupported');
  }
  const setGarminAuthBusy = (phase) => {
    const busy = Boolean(phase);
    garminAuthPhase = phase || null;
    garminAuthForm.setAttribute('aria-busy', String(busy));
    [garminEmail, garminPassword, garminMfaCode].forEach((field) => { field.disabled = busy; });
    garminAuthSubmit.disabled = busy;
    garminCancel.disabled = busy;
    garminDisconnectButton.disabled = busy || garminOperationNeedsResolution();
    garminAuthProgress.hidden = !busy;
    garminAuthProgress.querySelector('span:last-child').textContent = busy ? garminText(phase) : '';
    refreshGarminAccordionSummary();
  };
  const setGarminDisconnected = (generation) => {
    garminStatusRead += 1;
    garminConnected = false;
    garminConnectionKnown = true;
    garminStatusUnavailable = false;
    garminConnectionGeneration = generation || garminConnectionGeneration;
    garminDestinationNames = [];
    const destination = document.getElementById('garminDestination');
    destination.hidden = true;
    destination.textContent = '';
    garminPanel.hidden = true;
    garminAuthForm.dataset.open = '';
    garminAuthForm.hidden = true;
    garminConnectButton.hidden = false;
    garminDisconnectButton.hidden = true;
    garminConnectionRetry.hidden = true;
    setGarminConnectionMessage('disconnected');
  };
  garminConnectButton.addEventListener('click', () => {
    if (garminConnectionActionBusy || garminPending) return;
    garminAuthForm.dataset.open = 'true'; garminAuthForm.hidden = false;
    garminConnectButton.hidden = true; garminEmail.focus();
  });
  garminAuthForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (garminPending || garminConnectionActionBusy) return;
    const attempt = ++garminAuthAttempt;
    garminPending = true;
    garminConnectionActionBusy = true;
    garminStatusRead += 1;
    const email = garminEmail.value;
    let password = garminPassword.value;
    const completingMfa = Boolean(garminChallenge);
    let focusMfaAfterUnlock = false;
    garminPassword.value = '';
    setGarminAuthBusy(completingMfa ? 'validatingMfa' : 'connecting');
    try {
      const result = garminChallenge
        ? await garminFetch('/api/garmin/auth/finish', { method: 'POST', body: JSON.stringify({ challenge_id: garminChallenge, code: garminMfaCode.value }) })
        : await garminFetch('/api/garmin/auth/start', { method: 'POST', body: JSON.stringify({ email, password }) });
      if (attempt !== garminAuthAttempt) return;
      if (result.status === 'mfa_required') {
        garminChallenge = result.challenge_id; garminMfaField.hidden = false; garminCancel.hidden = false;
        garminEmail.required = false; garminPassword.required = false;
        setGarminConnectionMessage('mfaRequired');
        focusMfaAfterUnlock = true;
      } else {
        garminChallenge = null; garminAuthForm.dataset.open = ''; garminAuthForm.hidden = true; garminMfaCode.value = ''; garminMfaField.hidden = true; garminCancel.hidden = true; garminEmail.required = true; garminPassword.required = true;
        await refreshGarminStatus();
      }
    } catch (error) {
      if (attempt !== garminAuthAttempt) return;
      const key = ['connector_unavailable', 'connector_timeout', 'connector_auth_failed', 'connector_configuration_error', 'connector_service_error', 'cleanup_pending'].includes(error.message)
        || error.status === 503 || error.status === 504 ? 'authUnavailable'
        : error.message === 'rate_limited' ? 'authRateLimited' : 'authFailed';
      setGarminConnectionMessage(key);
    }
    finally {
      password = '';
      if (attempt === garminAuthAttempt) {
        garminPassword.value = '';
        garminPending = false;
        garminConnectionActionBusy = false;
        setGarminAuthBusy(null);
        if (focusMfaAfterUnlock && garminChallenge && !garminCard.hidden && garminMfaField.isConnected) {
          setAccordionOpen(garminAccordionTrigger, garminAccordionPanel, true);
          requestAnimationFrame(() => {
            if (attempt !== garminAuthAttempt || !garminChallenge || garminCard.hidden
                || garminAccordionPanel.hidden || garminAuthForm.hidden || garminMfaField.hidden
                || garminMfaCode.disabled || !garminMfaCode.isConnected) return;
            garminMfaCode.focus();
          });
        }
      }
    }
  });
  garminCancel.addEventListener('click', async () => {
    if (garminPending || garminConnectionActionBusy) return;
    const attempt = ++garminAuthAttempt;
    garminConnectionActionBusy = true;
    try {
      if (garminChallenge) await garminFetch('/api/garmin/auth/cancel', { method: 'POST', body: JSON.stringify({ challenge_id: garminChallenge }) }).catch(() => {});
      if (attempt !== garminAuthAttempt) return;
      garminChallenge = null; garminMfaCode.value = ''; garminMfaField.hidden = true; garminCancel.hidden = true;
      garminAuthForm.dataset.open = ''; garminAuthForm.hidden = true; garminEmail.required = true; garminPassword.required = true; garminConnectButton.hidden = false;
      setGarminConnectionMessage(garminConnected ? 'connected' : 'disconnected');
      garminConnectButton.focus();
    } finally {
      if (attempt === garminAuthAttempt) garminConnectionActionBusy = false;
    }
  });
  garminDisconnectButton.addEventListener('click', async () => {
    if (garminConnectionActionBusy || garminPending || garminOperationNeedsResolution()) return;
    const confirmed = await showConfirm({
      title: garminText('disconnect'), message: garminText('disconnectConfirm'), icon: 'unlink',
      confirmLabel: garminText('disconnect'), cancelLabel: t('shell.confirm.no'), confirmButtonClass: 'btn-primary',
      pendingText: garminText('disconnecting'), pendingMessage: garminText('disconnecting'),
      failureMessage: garminText('disconnectFailed'), keepOpenOnError: true,
      onConfirm: async () => {
        if (garminConnectionActionBusy || garminPending) return false;
        garminConnectionActionBusy = true;
        garminStatusRead += 1;
        try {
          const result = await garminFetch('/api/garmin/connection', { method: 'DELETE' });
          if (result.status !== 'disconnected') throw new Error('disconnect_unconfirmed');
          setGarminDisconnected(result.connection_generation);
          return true;
        } catch (error) {
          setGarminConnectionMessage('disconnectFailed');
          throw error;
        } finally { garminConnectionActionBusy = false; }
      },
    });
    if (confirmed && !garminConnectButton.hidden) garminConnectButton.focus();
  });
  garminPrescriptionForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (garminPending) return;
    const invalidFields = validateGarminEditorFields();
    if (invalidFields.length) {
      invalidFields[0].control.focus();
      invalidFields[0].control.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setGarminOperationMessage('invalidFields');
      return;
    }
    if (garminOperationMessageKey === 'invalidFields') { garminOperationMessageKey = null; garminOperationStatus.textContent = ''; }
    garminPending = true;
    const saveButton = document.getElementById('garminPrescriptionSave');
    saveButton.disabled = true;
    saveButton.textContent = garminText('savingReview');
    setGarminOperationMessage('savingReview');
    const prescriptionError = document.getElementById('garminPrescriptionError');
    prescriptionError.hidden = true;
    try {
      const prescription = garminPrescriptionFromForm();
      const saved = await garminFetch(`/api/trainings/${currentTrainingId}/garmin/prescription`, { method: 'PUT', body: JSON.stringify({
        expected_revision: garminSavedRevision, expected_training_date: training.dia,
        expected_connection_generation: garminConnectionGeneration, prescription,
      }) });
      garminSavedRevision = saved.revision;
      garminFingerprint = saved.fingerprint;
      garminConnectionGeneration = saved.connection_generation;
      garminPreviewSnapshot = { revision: saved.revision, fingerprint: saved.fingerprint,
        date: saved.date, connection_generation: saved.connection_generation };
      garminFormDirty = false;
      garminEditingRequested = false;
      garminEditorView.hidden = true;
      renderGarminPreview({ name: prescription.name, ...saved.preview, date: saved.date });
      garminOperationMessageKey = null;
      garminOperationStatus.textContent = '';
      document.getElementById('garminPreviewTitle').focus();
    } catch (error) {
      if (error.message === 'invalid_prescription') {
        showGarminContractDiagnostic(error.diagnostic);
      } else if (error.status === 409) setGarminOperationMessage('revisionConflict');
      else if (error.status === 422 || error.message === 'unsupported') setGarminOperationMessage('unsupported');
      else setGarminOperationMessage('saveFailed');
    }
    finally {
      garminPending = false;
      saveButton.disabled = false;
      saveButton.textContent = garminText('preview');
      if (garminPreviewModel) renderGarminPreview(garminPreviewModel);
    }
  });
  const performGarminAction = async (action) => {
    if (garminPending || garminDispatchUncertain || garminOperationNeedsResolution()
        || !garminPreviewSnapshot || !garminCurrentOperation && action !== 'publish') return;
    garminPending = true;
    const actionToken = ++garminRemoteActionToken;
    garminStatusRead += 1;
    // Ignore an operation poll that was already in flight when this explicit
    // action began; its older stage must not replace the new progress message.
    garminOperationRead += 1;
    clearTimeout(garminOperationTimer); garminOperationTimer = null;
    garminOperationController?.abort(); garminOperationController = null;
    if (garminPreviewModel) renderGarminPreview(garminPreviewModel);
    const actionKey = action === 'publish' ? 'publish' : action === 'update' ? 'update' : 'reschedule';
    const combinedUpdateReschedule = action === 'update' && garminCurrentOperation?.scheduled_date !== garminPreviewSnapshot.date;
    let remoteDispatched = false;
    try {
      if (action !== 'publish') {
        const confirmKey = combinedUpdateReschedule ? 'updateAndRescheduleConfirm' : `${actionKey}Confirm`;
        const confirmed = await showConfirm({ title: garminText(actionKey), message: garminText(confirmKey), confirmLabel: garminText(actionKey), cancelLabel: t('shell.confirm.no') });
        if (!confirmed || actionToken !== garminRemoteActionToken) return;
      }
      setGarminOperationMessage('checkingReview');
      const currentReview = await garminFetch(`/api/trainings/${encodeURIComponent(currentTrainingId)}/garmin`);
      if (actionToken !== garminRemoteActionToken) return;
      if (!currentReview.prescription || currentReview.prescription.revision !== garminPreviewSnapshot.revision
          || currentReview.prescription.fingerprint !== garminPreviewSnapshot.fingerprint
          || currentReview.training_date !== garminPreviewSnapshot.date
          || currentReview.connection_generation !== garminPreviewSnapshot.connection_generation) {
        if (currentReview.prescription) {
          garminSavedRevision = currentReview.prescription.revision;
          garminFingerprint = currentReview.prescription.fingerprint;
          garminConnectionGeneration = currentReview.connection_generation;
          garminPreviewSnapshot = { revision: currentReview.prescription.revision, fingerprint: currentReview.prescription.fingerprint,
            date: currentReview.training_date, connection_generation: currentReview.connection_generation };
          fillGarminPrescription(currentReview.prescription.value);
          if (currentReview.prescription.preview && !garminFormDirty) {
            garminEditorView.hidden = true;
            renderGarminPreview({ name: currentReview.prescription.value.name,
              ...currentReview.prescription.preview, date: currentReview.training_date });
          }
        } else garminPreviewSnapshot = null;
        if (currentReview.operation) renderGarminOperation(currentReview.operation);
        setGarminOperationMessage('reviewChanged');
        return;
      }
      setGarminOperationMessage(action === 'publish' ? 'publishing' : action === 'update' ? 'updating' : 'rescheduling');
      remoteDispatched = true;
      const result = await garminFetch(`/api/trainings/${currentTrainingId}/garmin/publish`, { method: 'POST', body: JSON.stringify({
        ...garminPreviewSnapshot,
        expected_date: garminPreviewSnapshot.date,
        expected_revision: garminPreviewSnapshot.revision,
        expected_connection_generation: garminPreviewSnapshot.connection_generation,
        action,
        source_operation_id: action === 'publish' ? null : garminCurrentOperation?.operation_id,
      }) });
      if (actionToken !== garminRemoteActionToken) return;
      garminDispatchUncertain = false;
      renderGarminOperation({ ...result, operation_id: result.operation_id });
      const latest = await garminFetch(`/api/garmin/operations/${result.operation_id}`);
      if (actionToken === garminRemoteActionToken && latest.operation.operation_id === result.operation_id) renderGarminOperation(latest.operation);
    } catch (error) {
      if (actionToken !== garminRemoteActionToken) return;
      if (remoteDispatched) {
        try {
          const local = await garminFetch(`/api/trainings/${encodeURIComponent(currentTrainingId)}/garmin`);
          if (actionToken !== garminRemoteActionToken) return;
          if (local.operation) { garminDispatchUncertain = false; renderGarminOperation(local.operation); return; }
          garminDispatchUncertain = false;
        } catch { garminDispatchUncertain = true; }
      }
      if (remoteDispatched && garminDispatchUncertain) {
        setGarminOperationMessage('uncertain');
        garminOperationRetry.hidden = false;
      }
      else if (!remoteDispatched && error.status !== 404) setGarminOperationMessage('reviewFailed');
      else if (error.message === 'auth_required') setGarminOperationMessage('authError');
      else if (error.message === 'outcome_unknown') setGarminOperationMessage('uncertain');
      else if (error.status === 409) setGarminOperationMessage('revisionConflict');
      else if (error.status === 503 || error.name === 'TypeError') setGarminOperationMessage('connectError');
      else if (error.status === 404) { garminPreviewSnapshot = null; setGarminOperationMessage('sessionUnavailable'); }
      else if (error.status === 400) setGarminOperationMessage('reviewFailed');
      else if (remoteDispatched) setGarminOperationMessage('uncertain');
      else setGarminOperationMessage(action === 'update' ? 'updateFailed' : action === 'reschedule' ? 'rescheduleFailed' : 'publishFailed');
    }
    finally { if (actionToken === garminRemoteActionToken) { garminPending = false; if (garminPreviewModel) renderGarminPreview(garminPreviewModel); } }
  };
  document.getElementById('garminPublishButton').addEventListener('click', () => performGarminAction('publish'));
  document.getElementById('garminEditStructure').addEventListener('click', () => {
    if (garminPending || garminDispatchUncertain || garminOperationNeedsResolution()) return;
    garminEditingRequested = true;
    garminPreview.hidden = true;
    garminEditorView.hidden = false;
    document.getElementById('garminWorkoutName').focus();
    document.getElementById('garminWorkoutName').scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  garminOperationRetry.addEventListener('click', () => {
    if (garminPending) return;
    if (garminDispatchUncertain) {
      garminPending = true;
      const token = ++garminRemoteActionToken;
      garminOperationRetry.disabled = true;
      setGarminOperationMessage('verifyingResult');
      if (garminPreviewModel) renderGarminPreview(garminPreviewModel);
      void garminFetch(`/api/trainings/${encodeURIComponent(currentTrainingId)}/garmin`).then((local) => {
        if (token !== garminRemoteActionToken) return;
        if (local.operation) { garminDispatchUncertain = false; renderGarminOperation(local.operation); }
        else {
          garminDispatchUncertain = false;
          garminOperationRetry.hidden = true;
          setGarminOperationMessage('noOperationFound');
        }
      }).catch((error) => {
        if (token === garminRemoteActionToken) setGarminOperationMessage(error.status === 503 || error.name === 'TypeError' ? 'connectError' : 'statusReadError');
      }).finally(() => {
        if (token === garminRemoteActionToken) {
          garminPending = false; garminOperationRetry.disabled = false;
          if (garminPreviewModel) renderGarminPreview(garminPreviewModel);
        }
      });
      return;
    }
    if (garminCurrentOperation) renderGarminOperation(garminCurrentOperation);
  });
  garminUpdateButton.addEventListener('click', () => performGarminAction('update'));
  garminRescheduleButton.addEventListener('click', () => performGarminAction('reschedule'));
  garminReconcileButton.addEventListener('click', async () => {
    if (garminPending) return;
    garminPending = true;
    const actionToken = ++garminRemoteActionToken;
    const operationId = garminCurrentOperation?.operation_id;
    garminStatusRead += 1;
    clearTimeout(garminOperationTimer); garminOperationTimer = null;
    garminOperationController?.abort(); garminOperationController = null;
    garminOperationRead += 1;
    garminReconcileButton.disabled = true;
    setGarminOperationMessage('verifyingResult');
    if (garminPreviewModel) renderGarminPreview(garminPreviewModel);
    try {
      const current = await garminFetch(`/api/trainings/${currentTrainingId}/garmin`);
      if (actionToken !== garminRemoteActionToken) return;
      if (!operationId || current.operation?.operation_id !== operationId) {
        if (current.operation) renderGarminOperation(current.operation);
        else setGarminOperationMessage('operationNotFound');
        return;
      }
      const result = await garminFetch(`/api/garmin/operations/${operationId}/reconcile`, { method: 'POST', body: '{}' });
      if (actionToken !== garminRemoteActionToken || result.operation_id !== operationId) return;
      renderGarminOperation(result);
      const latest = await garminFetch(`/api/garmin/operations/${operationId}`);
      if (actionToken === garminRemoteActionToken && latest.operation.operation_id === operationId) renderGarminOperation(latest.operation);
    } catch (error) {
      if (actionToken !== garminRemoteActionToken) return;
      if (error.message === 'auth_required') setGarminOperationMessage('authError');
      else if (error.status === 503 || error.name === 'TypeError') setGarminOperationMessage('connectError');
      else if (error.status === 404) setGarminOperationMessage('operationNotFound');
      else setGarminOperationMessage('uncertain');
    }
    finally { if (actionToken === garminRemoteActionToken) { garminPending = false; if (garminPreviewModel) renderGarminPreview(garminPreviewModel); } }
  });
  void renderGarminStatus();
  try { activeAnalysisRequestKey = sessionStorage.getItem(analysisStorageKey()); } catch { activeAnalysisRequestKey = null; }
  analysisOutcomeUncertain = Boolean(activeAnalysisRequestKey);
  void loadAnalysisState();

  const onAnalysisVisibility = () => {
    if (document.visibilityState === 'hidden') {
      clearAnalysisTimer();
      return;
    }
    if (activeAnalysisId) {
      clearAnalysisTimer();
      void refreshAnalysisExecution(activeAnalysisId, ++analysisReadToken);
    } else if (!analysisStartPending && activeAnalysisRequestKey) {
      void loadAnalysisState();
    }
  };
  const onAnalysisPageHide = () => {
    analysisPageActive = false;
    clearAnalysisTimer();
    analysisReadToken += 1;
    analysisPendingRefresh = null;
    analysisReadController?.abort();
    document.removeEventListener('visibilitychange', onAnalysisVisibility);
  };
  window.addEventListener('pagehide', () => {
    clearTimeout(garminOperationTimer);
    garminOperationController?.abort();
    garminOperationController = null;
    garminOperationTimer = null;
    garminOperationRead += 1;
    garminOperationController?.abort();
  }, { once: true });
  const onAnalysisPageShow = (event) => {
    analysisPageActive = true;
    document.addEventListener('visibilitychange', onAnalysisVisibility);
    if (event.persisted) onAnalysisVisibility();
  };
  document.addEventListener('visibilitychange', onAnalysisVisibility);
  window.addEventListener('pagehide', onAnalysisPageHide);
  window.addEventListener('pageshow', onAnalysisPageShow);

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
  resultSourceSelect.value = training.result_data_source === 'manual' ? 'manual'
    : training.result_data_source === 'garmin_connect' ? 'garmin' : 'fit';
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
  const hydratedFeedbackSignature = feedbackSignature();
  feedbackBaselineSignature = hydratedFeedbackSignature;
  await autoFillWeatherField();
  if (feedbackSignature() === hydratedFeedbackSignature) feedbackBaselineSignature = feedbackSignature();
  setStatus('');
  renderLocalizedUi();
  refreshFeedbackAccordionSummary();

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
    confirmReplaceGarmin: () => showConfirm({
      title: t('session.garminImport.replaceTitle'), message: t('session.garminImport.replaceMessage'), icon: 'triangle-alert',
      confirmLabel: t('session.replaceConfirm'), cancelLabel: t('shell.confirm.no'),
    }),
    applyResponse: applyManualResults,
  });
  const applyCanonicalTraining = (canonical, { preserveFeedbackBaseline = false } = {}) => {
    let laps = [];
    if (['fit_upload', 'garmin_connect'].includes(canonical.result_data_source) && canonical.fit_summary_json) {
      try {
        const summary = JSON.parse(canonical.fit_summary_json);
        if (Array.isArray(summary.laps)) laps = summary.laps;
      } catch { /* malformed historical summaries stay readable without laps */ }
    }
    training = canonical;
    fitData = { ...canonical, laps };
    resultSourceSelect.value = canonical.result_data_source === 'manual' ? 'manual'
      : canonical.result_data_source === 'garmin_connect' ? 'garmin' : 'fit';
    renderFitData();
    if (!preserveFeedbackBaseline) feedbackBaselineSignature = feedbackPersistenceSnapshot || feedbackSignature();
    refreshFeedbackAccordionSummary();
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
    if (['manual', 'fit_upload', 'garmin_connect'].includes(training.result_data_source)) {
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
    if (result.status === 'invalid' || result.status === 'error') revealFeedbackError();
  };

  saveBtn.addEventListener('click', async () => {
    // No answered RPE means no manual write, no feedback write and no
    // navigation: the form keeps every value and only the group reports why.
    const rpe = requireFeedbackRpe();
    if (rpe === null) return;
    saveBtn.disabled = true;
    generateBtn.disabled = true;
    saveBtn.textContent = t('session.saving');
    setFeedbackProgress('savingChanges');
    feedbackPersistenceSnapshot = feedbackSignature();
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
      feedbackPersistenceSnapshot = null;
      setFeedbackProgress(null);
      refreshFeedbackAccordionSummary();
    }
  });

  generateBtn.addEventListener('click', async () => {
    if (analysisStartPending || activeAnalysisId) return;
    const rpe = requireFeedbackRpe();
    if (rpe === null) return;
    analysisStartPending = true;
    generateBtn.disabled = true;
    saveBtn.disabled = true;
    generateLabel.textContent = analysisKey('saving');
    setFeedbackProgress('savingChanges');
    feedbackPersistenceSnapshot = feedbackSignature();
    setAnalysisNotice('', false);
    try {
      const result = await persistCurrentState(rpe);
      if (result.status === 'invalid' || result.status === 'cancelled' || result.status === 'error') {
        reportPersistenceFailure(result);
        return;
      }
      training = await fetchTraining(id);
      if (!training) throw new Error('saved-session-unavailable');
      applyCanonicalTraining(training);
      currentTrainingId = training.id;
      let requestKey = null;
      try { requestKey = activeAnalysisRequestKey || sessionStorage.getItem(analysisStorageKey()); } catch { /* storage unavailable */ }
      requestKey ||= crypto.randomUUID();
      activeAnalysisRequestKey = requestKey;
      try { sessionStorage.setItem(analysisStorageKey(), requestKey); } catch { /* recovery can still use the response id */ }
      const execution = await startAiExecution({
        purpose: 'analysis', resource_id: String(training.id), idempotency_key: requestKey,
      });
      activeAnalysisId = execution.id;
      analysisReadToken += 1;
      analysisSection.hidden = false;
      analysisState.textContent = analysisKey('running');
      analysisNotice.hidden = true;
      void refreshAnalysisExecution(execution.id, analysisReadToken);
    } catch (error) {
      let matched = null;
      let requestKey = activeAnalysisRequestKey;
      if (!requestKey) try { requestKey = sessionStorage.getItem(analysisStorageKey()); } catch { /* storage unavailable */ }
      try {
        const executions = await fetchAiExecutions();
        matched = executions.find((item) => item.purpose === 'analysis' && String(item.resource_id) === String(currentTrainingId) && item.idempotency_key === requestKey);
      } catch { /* uncertain response is preserved and never replayed automatically */ }
      if (matched) {
        activeAnalysisId = matched.id;
        analysisOutcomeUncertain = false;
        analysisReadToken += 1;
        setAnalysisNotice('', false);
        void refreshAnalysisExecution(matched.id, analysisReadToken);
      } else {
        const code = error?.codes?.find((value) => [
          'aiUnavailable', 'accountUnavailable', 'executionLimit', 'usageLimit',
          'analysisRequiresCompletedResult', 'contextTooLarge', 'criticalContextTooLarge',
          'inputTooLarge', 'resourceNotFound', 'invalidFields',
        ].includes(value));
        if (code) {
          analysisOutcomeUncertain = false;
          activeAnalysisRequestKey = null;
          try { sessionStorage.removeItem(analysisStorageKey()); } catch { /* storage unavailable */ }
          const translated = analysisKey(`errors.${code}`);
          setAnalysisNotice(translated === `session.analysis.errors.${code}` ? 'knownStartFailure' : `errors.${code}`, false);
        } else {
          analysisOutcomeUncertain = true;
          setAnalysisNotice('outcomeUnknown', true);
        }
      }
    } finally {
      analysisStartPending = false;
      generateBtn.disabled = Boolean(activeAnalysisId || analysisOutcomeUncertain);
      saveBtn.disabled = false;
      generateLabel.textContent = analysisKey('analyze');
      feedbackPersistenceSnapshot = null;
      setFeedbackProgress(null);
      refreshFeedbackAccordionSummary();
    }
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
      revealFeedbackError();
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
    if (training.result_data_source === 'manual' || training.result_data_source === 'garmin_connect') {
      const garminSource = training.result_data_source === 'garmin_connect';
      const confirmed = await showConfirm({
        title: garminSource ? t('session.garminImport.replaceTitle') : t('session.replaceManualTitle'),
        message: garminSource ? t('session.garminImport.replaceMessage') : t('session.replaceManualMessage'), icon: 'triangle-alert',
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
    if (training.result_data_source === 'garmin_connect') formData.append('confirm_replace_garmin', 'true');
    setFeedbackProgress('importingResult');
    feedbackPersistenceSnapshot = feedbackSignature({ omitFile: true });
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
      fitFileInput.value = '';
      renderFitData();
      feedbackBaselineSignature = feedbackPersistenceSnapshot || feedbackSignature();
      refreshFeedbackAccordionSummary();
    } catch (error) {
      setStatus(error.message || t('session.errors.fitUpload'), 'error');
      revealFeedbackError();
    } finally {
      feedbackPersistenceSnapshot = null;
      setFeedbackProgress(null);
      refreshFeedbackAccordionSummary();
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
