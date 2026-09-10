import { initShell, getShellI18n, getUserPreferences, showConfirm, showShellToast, refreshIcons } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate as formatLocalizedDate, formatWeekday } from './shared/date.js';
import { fetchTraining, saveTrainingFeedback, saveManualTrainingResults, fetchShoes, deleteTraining, fetchWeather } from './shared/api.js';
import { KM_TO_MILES, convertDistanceInputValue, convertDistanceToKm, formatDistance, formatPaceFromMetric, formatTemperature } from './shared/units.js';
import { createImportGuidance } from './shared/workout-import-guidance.js';

// Sessions open contextually via /training-result.html?id=<id>; without an
// id there is nothing to show, so the page bounces back to the calendar.
export function resolveSessionId(search) {
  const raw = new URLSearchParams(search).get('id');
  const id = raw === null ? '' : raw.trim();
  return id === '' ? null : id;
}

export function formatDateLabel(iso, language = 'pt-BR') {
  return formatLocalizedDate(iso, language);
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

export function manualResultsPayload(values, distanceUnit = 'km') {
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
  return {
    distance_km: convertDistanceToKm(distance, distanceUnit), duration_seconds,
    avg_hr: optionalNumber(values.avg_hr), max_hr: optionalNumber(values.max_hr),
    elevation_gain_m: optionalNumber(values.elevation_gain_m), calories: optionalNumber(values.calories),
  };
}

export function syncManualDistanceUnit({ value, previousUnit = 'km', nextUnit = 'km' }) {
  const previous = previousUnit === 'mi' ? 'mi' : 'km';
  const next = nextUnit === 'mi' ? 'mi' : 'km';
  if (previous === next) return { value, unit: next, changed: false };
  const converted = convertDistanceInputValue(value, previous, next);
  return { value: converted === null ? value : String(converted), unit: next, changed: converted !== null };
}

export function resolveResultSource(training = {}, fitData = {}) {
  const source = fitData?.result_data_source ?? training?.result_data_source;
  return source === 'manual' || source === 'fit_upload' ? source : 'none';
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
  training,
  save,
  confirmReplaceFit,
  applyResponse,
}) {
  if (selectedSource !== 'manual') return { status: 'not-needed' };
  const payload = manualResultsPayload(values, distanceUnit);
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

// Local weekday name ('YYYY-MM-DD' parsed as a local date, never UTC).
export function weekdayLabel(iso, language) {
  return formatWeekday(iso, language);
}

// Verbatim Portuguese post-workout briefing. Placeholder names are shared
// with the English template so a single replace loop serves both languages.
export const PROMPT_TEMPLATE_PT = `Analise o treino de corrida abaixo considerando todo o histórico do meu treinamento, minha evolução recente, os treinos anteriores, o planejamento atual e minhas provas-alvo.

Quero que você aja como meu treinador de corrida e mantenha continuidade com o planejamento que já estamos seguindo.

DADOS DO TREINO PLANEJADO
Data: {{DATA}}
Dia da semana: {{DIA_SEMANA}}
Tipo de treino: {{TIPO_TREINO}}
Treino planejado: {{TREINO_PLANEJADO}}
FC alvo: {{FC_ALVO}}
RPE alvo: {{RPE_ALVO}}
Tênis: {{TENIS}}

DADOS DO TREINO REALIZADO
Fonte dos dados do treino: {{FONTE_DADOS}}{{OBSERVACAO_FONTE}}
Duração total: {{DURACAO}}
Distância total: {{DISTANCIA}}
Pace médio: {{PACE_MEDIO}}{{OBSERVACAO_PACE}}
Calorias: {{CALORIAS}}
FC média: {{FC_MEDIA}}
FC máxima: {{FC_MAXIMA}}
Desnível positivo: {{DESNIVEL_POSITIVO}}
Tênis utilizado: {{TENIS_UTILIZADO}}

Fonte da frequência cardíaca:
{{FONTE_FC}}

Condições:
Temperatura/Clima: {{TEMPERATURA_CLIMA}}
Terreno/percurso: {{TERRENO}}

Percepção do treino:
RPE percebido: {{RPE_PERCEBIDO}}
Respiração: {{RESPIRACAO}}
Sensação muscular: {{SENSACAO_MUSCULAR}}
Energia ao terminar: {{ENERGIA_FINAL}}

Dor ou desconforto:
{{DOR_DESCONFORTO}}

Feedback livre:
{{FEEDBACK}}

DADOS DETALHADOS
{{ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI}}

INSTRUÇÕES PARA A ANÁLISE
1. Compare o treino realizado com o treino planejado.
2. Analise pace, FC, percepção de esforço, duração, distância, altimetria, cadência e demais métricas disponíveis.
3. Não interprete pace isoladamente. Considere altimetria, temperatura, vento, terreno e percepção de esforço.
4. Para treinos controlados, intervalados ou progressivos, analise cada bloco separadamente e compare a consistência entre os blocos.
5. Para longos, analise também deriva de FC, evolução do pace, fadiga muscular, energia no final e capacidade aparente de continuar.
6. Dê maior importância à percepção de esforço quando: estiver muito quente; houver muitas subidas; a FC tiver sido medida apenas pelo sensor óptico; houver sinais de leitura inconsistente da FC.
7. Considere meu histórico recente de dores/desconfortos e observe especialmente qualquer recorrência ou mudança de padrão. Não presuma que um desconforto antigo voltou se eu não relatar sintomas.
8. Diferencie desconforto passageiro, fadiga normal de treinamento e sinais que justifiquem redução/interrupção da carga. Não faça diagnóstico médico a partir dos dados.
9. Compare o treino com sessões semelhantes que já fiz anteriormente quando isso trouxer informação útil sobre minha evolução.
10. Avalie se o treino confirma, melhora ou piora nossa leitura atual do meu condicionamento e da preparação para minhas provas-alvo.
11. Não altere automaticamente os próximos treinos só porque o treino de hoje foi muito bom. A progressão deve continuar conservadora e coerente com a carga acumulada.
12. Se houver motivo para modificar o próximo treino ou o restante da semana, explique exatamente o que mudaria e por quê. Caso contrário, confirme que o planejamento permanece.
13. Quando houver dados suficientes, destaque tendências relevantes de evolução, mas não extrapole pace de intervalos diretamente para pace de prova.
14. Ao final, dê uma conclusão curta classificando o treino, por exemplo: abaixo do esperado; adequado; bom; muito bom; excelente.
15. Termine informando: estado de recuperação/carga que o treino sugere; se o próximo treino permanece igual ou precisa ser ajustado; qualquer ponto específico que devemos observar nas próximas 24–48 horas.

Não preciso que você repita todos os números que enviei. Quero interpretação, comparação com meu histórico e implicações para o planejamento.`;

// Verbatim English twin. Placeholders are byte-identical to the Portuguese
// template; only prose and section titles differ.
export const PROMPT_TEMPLATE_EN = `Analyze the running workout below considering my entire training history, my recent evolution, previous workouts, current plan, and target races.

I want you to act as my running coach and maintain continuity with the plan we are currently following.

PLANNED WORKOUT DATA
Date: {{DATA}}
Day of the week: {{DIA_SEMANA}}
Workout type: {{TIPO_TREINO}}
Planned workout: {{TREINO_PLANEJADO}}
Target HR: {{FC_ALVO}}
Target RPE: {{RPE_ALVO}}
Shoe: {{TENIS}}

REALIZED WORKOUT DATA
Workout data source: {{FONTE_DADOS}}{{OBSERVACAO_FONTE}}
Total duration: {{DURACAO}}
Total distance: {{DISTANCIA}}
Average pace: {{PACE_MEDIO}}{{OBSERVACAO_PACE}}
Calories: {{CALORIAS}}
Average HR: {{FC_MEDIA}}
Max HR: {{FC_MAXIMA}}
Elevation gain: {{DESNIVEL_POSITIVO}}
Shoe used: {{TENIS_UTILIZADO}}

Heart rate source:
{{FONTE_FC}}

Conditions:
Temperature/Weather: {{TEMPERATURA_CLIMA}}
Terrain/route: {{TERRENO}}

Workout perception:
Perceived RPE: {{RPE_PERCEBIDO}}
Breathing: {{RESPIRACAO}}
Muscle sensation: {{SENSACAO_MUSCULAR}}
Energy at finish: {{ENERGIA_FINAL}}

Pain or discomfort:
{{DOR_DESCONFORTO}}

Free feedback:
{{FEEDBACK}}

DETAILED DATA
{{ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI}}

INSTRUCTIONS FOR ANALYSIS
1. Compare the realized workout with the planned workout.
2. Analyze pace, HR, perceived effort, duration, distance, elevation, cadence, and other available metrics.
3. Do not interpret pace in isolation. Consider elevation, temperature, wind, terrain, and perceived effort.
4. For controlled, interval, or progressive workouts, analyze each block separately and compare consistency across blocks.
5. For long runs, also analyze HR drift, pace evolution, muscle fatigue, finishing energy, and apparent capacity to continue.
6. Give more weight to perceived effort when: it is very hot; there are many uphills; HR was measured only by the optical sensor; there are signs of inconsistent HR readings.
7. Consider my recent history of pain/discomfort and specifically look for any recurrence or change in pattern. Do not assume an old discomfort has returned if I do not report symptoms.
8. Differentiate between temporary discomfort, normal training fatigue, and signs that justify load reduction/interruption. Do not make a medical diagnosis from the data.
9. Compare the workout with similar past sessions when it provides useful information about my progress.
10. Evaluate whether the workout confirms, improves, or worsens our current reading of my fitness and preparation for my target races.
11. Do not automatically alter upcoming workouts just because today's workout was very good. Progression must remain conservative and consistent with accumulated load.
12. If there is a reason to modify the next workout or the rest of the week, explain exactly what would change and why. Otherwise, confirm that the plan remains unchanged.
13. When sufficient data is available, highlight relevant evolutionary trends, but do not extrapolate interval pace directly to race pace.
14. At the end, provide a short conclusion classifying the workout, for example: below expectations; adequate; good; very good; excellent.
15. Finish by stating: suggested recovery/load status based on the workout; whether the next workout remains the same or needs adjustment; any specific point we should monitor over the next 24-48 hours.

I do not need you to repeat all the numbers I sent. I want interpretation, comparison with my history, and implications for the planning.`;

export function resolveTemplateLang(lang) {
  return lang === 'en-US' ? 'en-US' : 'pt-BR';
}

export function templateFor(lang) {
  return resolveTemplateLang(lang) === 'en-US' ? PROMPT_TEMPLATE_EN : PROMPT_TEMPLATE_PT;
}

// Fills the shared placeholder contract: blank/null/undefined become "-".
export function buildAnalysisPrompt(template, values) {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    const optionalNarrative = key === 'OBSERVACAO_FONTE' || key === 'OBSERVACAO_PACE';
    const replacement =
      value === undefined || value === null || String(value).trim() === ''
        ? (optionalNarrative ? '' : '-')
        : String(value);
    output = output.split(`{{${key}}}`).join(replacement);
  }
  return output;
}

// Renders {{DOR_DESCONFORTO}} for the briefing: a "no" answer (or an
// unanswered select) reports no pain; a "yes" answer shows the description,
// or an explicit note when none was typed.
export function painPromptText(hasPainValue, description, translate) {
  if (hasPainValue !== 'yes') {
    return translate('feedback.noPainReported');
  }
  const trimmed = String(description ?? '').trim();
  return trimmed !== '' ? trimmed : translate('feedback.yesWithoutDescription');
}

// Maps the loaded session row plus the current form state onto the shared
// placeholder contract. FIT metrics come from persisted data when available,
// falling back to dashes.
export function collectPromptValues({ training, form, fitData, preferences = {} }) {
  const distanceUnit = preferences.distance_unit === 'mi' ? 'mi' : 'km';
  const source = resolveResultSource(training, fitData);
  const manual = source === 'manual';
  const english = form.language === 'en-US';
  const sourceText = source === 'manual'
    ? (english ? 'Manually entered by the user' : 'Inserção manual pelo usuário')
    : source === 'fit_upload'
      ? (english ? 'FIT file' : 'Arquivo FIT')
      : (english ? 'Not provided' : 'Não informada');
  return {
    DATA: formatDateLabel(training.dia, form.language),
    DIA_SEMANA: weekdayLabel(training.dia, form.language),
    TIPO_TREINO: training.tipo,
    TREINO_PLANEJADO: training.treino,
    FC_ALVO: training.fc_alvo,
    RPE_ALVO: training.rpe,
    TENIS: training.tenis,
    FONTE_DADOS: sourceText,
    OBSERVACAO_FONTE: manual ? (english
      ? '\nNote: the aggregate data below was entered manually. No detailed lap data from a FIT file is available.'
      : '\nObservação: os dados agregados abaixo foram informados manualmente. Não há dados detalhados de voltas provenientes de um arquivo FIT.') : '',
    DURACAO: fitData?.fit_duration || '-',
    DISTANCIA: fitData?.fit_distance != null ? formatDistance(fitData.fit_distance, distanceUnit) : '-',
    PACE_MEDIO: fitData?.fit_avg_pace ? formatPaceFromMetric(fitData.fit_avg_pace, distanceUnit) : '-',
    CALORIAS: fitData?.fit_calories == null ? '-' : `${fitData.fit_calories} kcal`,
    OBSERVACAO_PACE: manual && fitData?.fit_avg_pace ? (english
      ? '\nAverage pace calculated by Kinesis from total distance and duration.'
      : '\nPace médio calculado pelo Kinesis a partir da distância e duração totais.') : '',
    FC_MEDIA: fitData?.fit_avg_hr || '-',
    FC_MAXIMA: fitData?.fit_max_hr || '-',
    DESNIVEL_POSITIVO: fitData?.fit_elevation_gain != null ? `${fitData.fit_elevation_gain} m` : '-',
    TENIS_UTILIZADO: form.feedback_shoe,
    FONTE_FC: form.hr_source_label,
    TEMPERATURA_CLIMA: form.feedback_weather,
    TERRENO: form.terrain_label,
    RPE_PERCEBIDO: form.feedback_rpe,
    RESPIRACAO: form.breathing_label,
    SENSACAO_MUSCULAR: form.muscle_label,
    ENERGIA_FINAL: form.energy_label,
    DOR_DESCONFORTO: form.pain_description,
    FEEDBACK: form.feedback_notas,
    ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI: source !== 'fit_upload'
      ? '-'
      : fitData?.laps?.length
        ? buildLapsMarkdown(fitData.laps, preferences)
        : form.fitAttached
          ? 'Ver anexo'
          : '-',
  };
}

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

// Builds a Markdown table from parsed FIT lap data so it can be injected
// directly into the AI coach prompt. Returns an empty string when there are
// no laps to display.
export function buildLapsMarkdown(laps, preferences = {}) {
  const distanceUnit = preferences.distance_unit === 'mi' ? 'mi' : 'km';
  if (!Array.isArray(laps) || laps.length === 0) return '';
  const header = '| # | Type | Distance | Duration | Pace | HR avg. | Ascent |';
  const separator = '|---|------|----------|----------|------|---------|--------|';
  const rows = laps.map((lap) => {
    const distance = lap.distanceLabel ?? '-';
    const duration = lap.durationLabel ?? '-';
    const pace = lap.avgPaceLabel ?? '-';
    const hr = lap.avgHeartRate ?? '-';
    const ascent = lap.ascentMeters != null ? `${lap.ascentMeters} m` : '-';
    const paceLabel = pace === '-' ? `- min/${distanceUnit}` : formatPaceFromMetric(pace, distanceUnit);
    const distanceValue = distance === '-' ? '-' : formatDistance(distance, distanceUnit).replace(/\s(km|mi)$/, '');
    return `| ${lap.lap} | ${lap.stepType} | ${distanceValue} ${distanceUnit} | ${duration} | ${paceLabel} | ${hr} | ${ascent} |`;
  });
  return [header, separator, ...rows].join('\n');
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

const HR_SOURCE_LABEL_KEYS = {
  chest_strap: 'session.hrSourceStrap',
  optical_watch: 'session.hrSourceOptical',
  none: 'session.hrSourceNone',
};

const TERRAIN_LABEL_KEYS = {
  asphalt: 'terrain.asphalt',
  trail: 'terrain.trail',
  track: 'terrain.track',
  treadmill: 'terrain.treadmill',
  mixed: 'terrain.mixed',
};

const BREATHING_LABEL_KEYS = {
  controlled: 'breathing.controlled',
  panting: 'breathing.panting',
  heavy: 'breathing.heavy',
};

const MUSCLE_LABEL_KEYS = {
  light: 'muscle.light',
  normal: 'muscle.normal',
  heavy: 'muscle.heavy',
  fatigued: 'muscle.fatigued',
};

const ENERGY_LABEL_KEYS = {
  surplus: 'energy.surplus',
  limit: 'energy.limit',
  exhausted: 'energy.exhausted',
};

async function initTrainingResult() {
  const statusEl = document.getElementById('status');
  const dateEl = document.getElementById('sessionDate');
  const saveBtn = document.getElementById('saveBtn');
  const rpeSelector = document.getElementById('feedbackRpe');
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
  let promptText = '';
  let manualDistanceInputUnit = 'km';
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
    const fragment = document.createDocumentFragment();
    const distanceUnit = getUserPreferences().distance_unit;
    for (const lap of laps) {
      const tr = document.createElement('tr');
      const distance = lap.distanceLabel ?? '-';
      const duration = lap.durationLabel ?? '-';
      const pace = formatPaceFromMetric(lap.avgPaceLabel ?? '-', distanceUnit);
      const hr = lap.avgHeartRate ?? '-';
      const ascent = lap.ascentMeters != null ? `${lap.ascentMeters} m` : '-';
      tr.innerHTML = [
        `<td>${escapeHtmlText(String(lap.lap))}</td>`,
        `<td>${escapeHtmlText(lap.stepType)}</td>`,
        `<td>${escapeHtmlText(distance === '-' ? '-' : formatDistance(distance, distanceUnit).replace(/\s(km|mi)$/, ''))} ${distance === '-' ? '' : distanceUnit}</td>`,
        `<td>${escapeHtmlText(duration)}</td>`,
        `<td>${escapeHtmlText(pace)}</td>`,
        `<td>${escapeHtmlText(String(hr))}</td>`,
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

  const loadShoes = async () => {
    const shoes = await fetchShoes();
    shoeSelect.innerHTML = '<option value="">–</option>';
    for (const shoe of shoes) {
      const option = document.createElement('option');
      const label = shoe.brand && shoe.model ? `${shoe.brand} ${shoe.model}` : shoe.model || shoe.brand || shoe.id;
      option.value = shoe.id;
      option.textContent = label;
      shoeSelect.appendChild(option);
    }
    if (!training.feedback_shoe_id && training.feedback_shoe) {
      const legacy = document.createElement('option');
      legacy.value = '';
      legacy.textContent = training.feedback_shoe;
      legacy.disabled = true;
      legacy.selected = true;
      shoeSelect.appendChild(legacy);
    }
  };

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
  document.title = t('training.title');
  applyTooltips();
  // The shell may have injected sidebar/topbar markup around the session
  // card; re-initializing Lucide ensures the card's trash icon is rendered
  // as an SVG and never left as an empty <i> tag.
  refreshIcons();

  setStatus(t('session.loading'));
  let training;
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

  const collectFormState = () => {
    const hrValue = hrSourceSelect.value;
    const hrKey = HR_SOURCE_LABEL_KEYS[hrValue];
    const terrainKey = TERRAIN_LABEL_KEYS[terrainInput.value];
    const breathingKey = BREATHING_LABEL_KEYS[breathingInput.value];
    const muscleKey = MUSCLE_LABEL_KEYS[muscleInput.value];
    const energyKey = ENERGY_LABEL_KEYS[energyInput.value];
    const hasPainValue = hasPainSelect.value;
    return {
      feedback_rpe: normalizeFeedbackRpe(rpeSelector.querySelector('input[type="radio"]:checked')?.value ?? ''),
      feedback_notas: notesInput.value,
      feedback_shoe_id: shoeSelect.value || null,
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
  const persistManualResults = () => persistManualResultsIfNeeded({
    selectedSource: resultSourceSelect.value,
    values: manualInputValues(),
    distanceUnit: getUserPreferences().distance_unit,
    training,
    save: (payload) => saveManualTrainingResults(id, payload),
    confirmReplaceFit: () => showConfirm({
      title: t('session.replaceFitTitle'), message: t('session.replaceFitMessage'), icon: 'triangle-alert',
      confirmLabel: t('session.replaceConfirm'), cancelLabel: t('shell.confirm.no'),
    }),
    applyResponse: applyManualResults,
  });
  const reportManualPersistence = (result) => {
    if (result.status === 'invalid') setStatus(t('session.errors.manualValidation'), 'error');
    if (result.status === 'error') setStatus(result.error?.message || t('session.errors.manualSave'), 'error');
  };

  saveBtn.addEventListener('click', async () => {
    const state = collectFormState();
    if (Number.isNaN(state.feedback_rpe)) {
      setStatus(t('session.errors.rpe'), 'error');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = t('session.saving');
    try {
      const manualResult = await persistManualResults();
      if (manualResult.status === 'invalid' || manualResult.status === 'cancelled' || manualResult.status === 'error') {
        reportManualPersistence(manualResult);
        return;
      }
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
      await saveTrainingFeedback(id, payload);
      window.location.href = '/calendar.html';
    } catch {
      setStatus(t('session.errors.save'), 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = t('session.save');
    }
  });

  generateBtn.addEventListener('click', async () => {
    generateBtn.disabled = true;
    generateLabel.textContent = t('session.generatingPrompt');
    try {
      const manualResult = await persistManualResults();
      if (manualResult.status === 'invalid' || manualResult.status === 'cancelled' || manualResult.status === 'error') {
        reportManualPersistence(manualResult);
        return;
      }
      promptText = buildAnalysisPrompt(
        templateFor(i18n.language),
        collectPromptValues({ training, form: collectFormState(), fitData, preferences: getUserPreferences() })
      );
      promptOutput.value = promptText;
      promptSection.hidden = false;
    } finally {
      generateBtn.disabled = false;
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
      training = { ...training, ...fitData };
      renderFitData();
    } catch (error) {
      setStatus(error.message || t('session.errors.fitUpload'), 'error');
    }
  });

  document.addEventListener('app:languagechange', () => {
    document.title = t('training.title');
    if (training) dateEl.textContent = formatDateLabel(training.dia, i18n.language);
    if (!saveBtn.disabled) saveBtn.textContent = t('session.save');
    if (!generateBtn.disabled) generateLabel.textContent = t('session.generatePrompt');
    if (!copyPromptBtn.disabled) copyLabel.textContent = t('session.copyPrompt');
    renderFitDropzoneState();
    renderWeatherAutofill();
    renderFitData();
    applyTooltips();
    importGuidance.render();
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
