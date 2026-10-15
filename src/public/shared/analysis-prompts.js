import { translate } from './i18n.js';
import { formatDate as formatLocalizedDate, formatWeekday } from './date.js';
import { formatDistance, formatPaceFromMetric } from './units.js';

export function formatDateLabel(iso, language = 'pt-BR') {
  return formatLocalizedDate(iso, language);
}


export function resolveResultSource(training = {}, fitData = {}) {
  const source = fitData?.result_data_source ?? training?.result_data_source;
  return source === 'manual' || source === 'fit_upload' ? source : 'none';
}


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
Ganho de altitude: {{DESNIVEL_POSITIVO}}
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

// Converts the persisted training row into the prompt's feedback shape. The
// row is authoritative after a save; only locale-derived labels and the
// temporary attachment indicator come from the presentation context.
export function buildCanonicalPromptForm(training = {}, {
  language = 'pt-BR',
  messages = {},
  fitAttached = false,
} = {}) {
  const t = (key) => translate(messages, key);
  const hrKey = HR_SOURCE_LABEL_KEYS[training.feedback_hr_source];
  const terrainKey = TERRAIN_LABEL_KEYS[training.feedback_terrain];
  const breathingKey = BREATHING_LABEL_KEYS[training.feedback_breathing];
  const muscleKey = MUSCLE_LABEL_KEYS[training.feedback_muscle];
  const energyKey = ENERGY_LABEL_KEYS[training.feedback_energy];
  const hasPain = training.feedback_has_pain === 'yes' ||
    (training.feedback_has_pain == null && Boolean(training.feedback_pain));
  return {
    feedback_rpe: training.feedback_rpe ?? null,
    feedback_notas: training.feedback_notas ?? '',
    feedback_shoe: training.feedback_shoe ?? '',
    feedback_hr_source: training.feedback_hr_source ?? null,
    hr_source_label: hrKey ? t(hrKey) : '',
    feedback_weather: training.feedback_weather ?? '',
    feedback_terrain: training.feedback_terrain ?? null,
    terrain_label: terrainKey ? t(terrainKey) : '',
    feedback_breathing: training.feedback_breathing ?? null,
    breathing_label: breathingKey ? t(breathingKey) : '',
    feedback_muscle: training.feedback_muscle ?? null,
    muscle_label: muscleKey ? t(muscleKey) : '',
    feedback_energy: training.feedback_energy ?? null,
    energy_label: energyKey ? t(energyKey) : '',
    feedback_has_pain: hasPain ? 'yes' : 'no',
    feedback_pain: training.feedback_pain ?? '',
    pain_description: painPromptText(hasPain ? 'yes' : 'no', training.feedback_pain, t),
    language,
    fitAttached,
  };
}

// Maps the loaded session row plus the current form state onto the shared
// placeholder contract. FIT metrics come from persisted data when available,
// falling back to dashes.
export function collectPromptValues({ training, form, fitData, preferences = {}, messages = {} }) {
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
        ? buildLapsMarkdown(fitData.laps, { ...preferences, language: form.language, messages })
        : form.fitAttached
          ? 'Ver anexo'
          : '-',
  };
}


export function formatCadence(value, language = 'en-US') {
  if (!Number.isFinite(value) || value < 0) return '-';
  return String(value);
}

export function splitPaceLabel(value) {
  const text = String(value ?? '').trim();
  const match = /^(.*)\s+(min\/(?:km|mi))$/.exec(text);
  return match ? { value: match[1], unit: match[2] } : { value: text || '-', unit: '' };
}

const LAP_TYPE_KEYS = {
  Run: 'session.fitLapTypes.run',
  Warmup: 'session.fitLapTypes.warmup',
  Cooldown: 'session.fitLapTypes.cooldown',
  Rest: 'session.fitLapTypes.rest',
};

export function formatLapType(value, language = 'en-US', messages = {}) {
  const canonical = String(value ?? '');
  const key = LAP_TYPE_KEYS[canonical];
  if (!key) return canonical || '-';
  const translated = translate(messages, key);
  return translated === key ? canonical : translated;
}

// Builds a Markdown table from parsed FIT lap data so it can be injected
// directly into the AI coach prompt. Returns an empty string when there are
// no laps to display.
export function buildLapsMarkdown(laps, preferences = {}) {
  const distanceUnit = preferences.distance_unit === 'mi' ? 'mi' : 'km';
  if (!Array.isArray(laps) || laps.length === 0) return '';
  const english = preferences.language !== 'pt-BR';
  const header = english
    ? '| # | Type | Distance | Duration | Pace | HR avg. | Cadence (spm) | Ascent (m) |'
    : '| # | Tipo | Distância | Duração | Pace | FC média | Cadência (ppm) | Subida (m) |';
  const separator = '|---|------|----------|----------|------|---------|--------------------|--------|';
  const rows = laps.map((lap) => {
    const distance = lap.distanceLabel ?? '-';
    const duration = lap.durationLabel ?? '-';
    const pace = lap.avgPaceLabel ?? '-';
    const hr = lap.avgHeartRate ?? '-';
    const cadence = formatCadence(lap.avgCadenceSpm, preferences.language);
    const stepType = formatLapType(lap.stepType, preferences.language, preferences.messages);
    const ascent = lap.ascentMeters != null ? String(lap.ascentMeters) : '-';
    const paceLabel = pace === '-' ? `- min/${distanceUnit}` : formatPaceFromMetric(pace, distanceUnit);
    const distanceValue = distance === '-' ? '-' : formatDistance(distance, distanceUnit).replace(/\s(km|mi)$/, '');
    return `| ${lap.lap} | ${stepType} | ${distanceValue} ${distanceUnit} | ${duration} | ${paceLabel} | ${hr} | ${cadence} | ${ascent} |`;
  });
  return [header, separator, ...rows].join('\n');
}


export const HR_SOURCE_LABEL_KEYS = {
  chest_strap: 'session.hrSourceStrap',
  optical_watch: 'session.hrSourceOptical',
  none: 'session.hrSourceNone',
};

export const TERRAIN_LABEL_KEYS = {
  asphalt: 'terrain.asphalt',
  trail: 'terrain.trail',
  track: 'terrain.track',
  treadmill: 'terrain.treadmill',
  mixed: 'terrain.mixed',
};

export const BREATHING_LABEL_KEYS = {
  controlled: 'breathing.controlled',
  panting: 'breathing.panting',
  heavy: 'breathing.heavy',
};

export const MUSCLE_LABEL_KEYS = {
  light: 'muscle.light',
  normal: 'muscle.normal',
  heavy: 'muscle.heavy',
  fatigued: 'muscle.fatigued',
};

export const ENERGY_LABEL_KEYS = {
  surplus: 'energy.surplus',
  limit: 'energy.limit',
  exhausted: 'energy.exhausted',
};
