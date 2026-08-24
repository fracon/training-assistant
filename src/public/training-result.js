import { initShell, getShellI18n } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { fetchTraining, saveTrainingFeedback } from './shared/api.js';

// Sessions open contextually via /training-result.html?id=<id>; without an
// id there is nothing to show, so the page bounces back to the calendar.
export function resolveSessionId(search) {
  const raw = new URLSearchParams(search).get('id');
  const id = raw === null ? '' : raw.trim();
  return id === '' ? null : id;
}

export function formatDateLabel(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
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

// The .FIT upload only makes sense when a watch was actually used.
export function isFitFieldVisible(smartwatchValue) {
  return smartwatchValue === 'sim';
}

// Local weekday name ('YYYY-MM-DD' parsed as a local date, never UTC).
export function weekdayLabel(iso, language) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const localeTag = resolveTemplateLang(language);
  return new Intl.DateTimeFormat(localeTag, { weekday: 'long' }).format(date);
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
Duração total: {{DURACAO}}
Distância total: {{DISTANCIA}}
Pace médio: {{PACE_MEDIO}}
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
Total duration: {{DURACAO}}
Total distance: {{DISTANCIA}}
Average pace: {{PACE_MEDIO}}
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
    const replacement =
      value === undefined || value === null || String(value).trim() === ''
        ? '-'
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
// placeholder contract. Garmin metrics are not parsed on this screen yet, so
// they stay as dashes and detailed data points to an attachment.
export function collectPromptValues({ training, form }) {
  return {
    DATA: formatDateLabel(training.dia),
    DIA_SEMANA: weekdayLabel(training.dia, form.language),
    TIPO_TREINO: training.tipo,
    TREINO_PLANEJADO: training.treino,
    FC_ALVO: training.fc_alvo,
    RPE_ALVO: training.rpe,
    TENIS: training.tenis,
    DURACAO: '-',
    DISTANCIA: '-',
    PACE_MEDIO: '-',
    FC_MEDIA: '-',
    FC_MAXIMA: '-',
    DESNIVEL_POSITIVO: '-',
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
    ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI: form.fitAttached
      ? 'Ver anexo'
      : '-',
  };
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
];

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
  const rpeInput = document.getElementById('feedbackRpe');
  const notesInput = document.getElementById('feedbackNotas');
  const smartwatchSelect = document.getElementById('smartwatchSelect');
  const fitField = document.getElementById('fitField');
  const fitFileInput = document.getElementById('fitFileInput');
  const shoeInput = document.getElementById('feedbackShoe');
  const hrSourceSelect = document.getElementById('hrSourceSelect');
  const weatherInput = document.getElementById('feedbackWeather');
  const terrainInput = document.getElementById('feedbackTerrain');
  const breathingInput = document.getElementById('feedbackBreathing');
  const muscleInput = document.getElementById('feedbackMuscle');
  const energyInput = document.getElementById('feedbackEnergy');
  const hasPainSelect = document.getElementById('feedbackHasPain');
  const painDescriptionField = document.getElementById('painDescriptionContainer');
  const painInput = document.getElementById('feedbackPain');
  const generateBtn = document.getElementById('generateBtn');
  const generateLabel = generateBtn.querySelector('span');

  let i18n = null;
  let copiedTimer = null;
  const t = (key) => translate(i18n ? i18n.messages : {}, key);

  const setStatus = (message, tone = '') => {
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  };

  const syncFitFieldVisibility = () => {
    fitField.hidden = !isFitFieldVisible(smartwatchSelect.value);
  };
  smartwatchSelect.addEventListener('change', syncFitFieldVisibility);

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

  const id = resolveSessionId(window.location.search);
  if (!id) {
    window.location.href = '/calendar.html';
    return;
  }

  await initShell();
  i18n = getShellI18n();
  document.title = t('training.title');

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

  dateEl.textContent = formatDateLabel(training.dia);
  for (const [field, elementId] of PLANNED_FIELDS) {
    document.getElementById(elementId).textContent = plannedValue(training, field);
  }

  rpeInput.value = training.feedback_rpe ?? '';
  notesInput.value = training.feedback_notas ?? '';
  shoeInput.value = training.feedback_shoe ?? '';
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
  smartwatchSelect.value =
    training.has_smartwatch === null || training.has_smartwatch === undefined
      ? 'sim'
      : training.has_smartwatch
        ? 'sim'
        : 'nao';
  hrSourceSelect.value = training.feedback_hr_source ?? '';
  syncFitFieldVisibility();
  syncPainVisibility();
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
      feedback_rpe: normalizeFeedbackRpe(rpeInput.value),
      feedback_notas: notesInput.value,
      has_smartwatch: isFitFieldVisible(smartwatchSelect.value),
      feedback_shoe: shoeInput.value,
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

  saveBtn.addEventListener('click', async () => {
    const state = collectFormState();
    if (Number.isNaN(state.feedback_rpe)) {
      setStatus(t('session.errors.rpe'), 'error');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = t('session.saving');
    try {
      const {
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
      saveBtn.disabled = false;
      saveBtn.textContent = t('session.save');
      setStatus(t('session.errors.save'), 'error');
    }
  });

  generateBtn.addEventListener('click', async () => {
    const promptText = buildAnalysisPrompt(
      templateFor(i18n.language),
      collectPromptValues({ training, form: collectFormState() })
    );
    generateBtn.disabled = true;
    const copied = await copyAnalysisPrompt(promptText);
    generateBtn.disabled = false;
    generateLabel.textContent = copied ? t('session.copied') : t('session.generatePrompt');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      generateLabel.textContent = t('session.generatePrompt');
    }, 2000);
  });

  document.addEventListener('app:languagechange', () => {
    document.title = t('training.title');
    if (!saveBtn.disabled) saveBtn.textContent = t('session.save');
    if (!generateBtn.disabled) generateLabel.textContent = t('session.generatePrompt');
  });
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initTrainingResult();
}
