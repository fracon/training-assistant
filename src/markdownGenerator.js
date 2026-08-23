'use strict';

const { DEFAULT_LANGUAGE, normalizeLanguage } = require('./auth/language');

const MESSAGES = {
  'en-US': require('./public/locales/en.json'),
  'pt-BR': require('./public/locales/pt.json'),
};

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatMetric(value) {
  return value === null || value === undefined ? '-' : String(value);
}

const TABLE_HEADER =
  '| Step | Lap | Time | Cumulative | Distance (km) | Avg Pace | Best Pace | Avg HR | Max HR | Ascent | Descent | Avg Cadence | Max Cadence | Stride (m) | Calories |';

const TABLE_DIVIDER = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

function toRow(lap) {
  const cells = [
    lap.stepType,
    lap.lap,
    lap.durationLabel,
    lap.cumulativeLabel,
    lap.distanceLabel,
    lap.avgPaceLabel,
    lap.bestPaceLabel,
    formatMetric(lap.avgHeartRate),
    formatMetric(lap.maxHeartRate),
    formatMetric(lap.ascentMeters),
    formatMetric(lap.descentMeters),
    formatMetric(lap.avgCadenceSpm),
    formatMetric(lap.maxCadenceSpm),
    formatMetric(lap.strideMeters),
    formatMetric(lap.calories),
  ];
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

function buildLapsTable(laps, t) {
  if (!laps.length) return t.lapsFallback;
  return [TABLE_HEADER, TABLE_DIVIDER, ...laps.map(toRow)].join('\n');
}

function orUninformed(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text === '' ? fallback : escapeCell(text);
}

function orNoneReported(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text === '' ? fallback : escapeCell(text);
}

function rpeLabel(value, fallback) {
  return value === null || value === undefined ? fallback : `${value}/5`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDate(iso) {
  if (typeof iso !== 'string') return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function plannedDate(iso, dayFirst, fallback) {
  const date = parseDate(iso);
  if (!date) return fallback;
  const day = pad2(date.getUTCDate());
  const month = pad2(date.getUTCMonth() + 1);
  return dayFirst ? `${day}/${month}/${date.getUTCFullYear()}` : `${month}/${day}/${date.getUTCFullYear()}`;
}

function weekdayLabel(iso, weekdays, fallback) {
  const date = parseDate(iso);
  return date ? weekdays[date.getUTCDay()] : fallback;
}

function timeOfDay(iso, fallback) {
  const date = parseDate(iso);
  return date ? `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}` : fallback;
}

function informedDuration(label, fallback) {
  return typeof label === 'string' && label !== '--:--' && label !== '' ? label : fallback;
}

function buildValues(summary, feedback, t) {
  const activity = summary.activity ?? {};
  const totals = summary.totals ?? {};
  const startTime = activity.startTime;
  return {
    '{{DATA}}': plannedDate(startTime, t.dayFirst, t.notInformed),
    '{{DIA_SEMANA}}': weekdayLabel(startTime, t.weekdays, t.notInformed),
    '{{TIPO_TREINO}}': orUninformed(feedback.tipoTreino, t.notInformed),
    '{{TREINO_PLANEJADO}}': orUninformed(feedback.treinoPlanejado, t.notInformed),
    '{{FC_ALVO}}': orUninformed(feedback.fcAlvo, t.notInformed),
    '{{RPE_ALVO}}': rpeLabel(feedback.rpeAlvo, t.notInformed),
    '{{TENIS}}': orUninformed(feedback.tenis, t.notInformed),
    '{{DURACAO}}': informedDuration(totals.durationLabel, t.notInformed),
    '{{DISTANCIA}}':
      totals.distanceKm == null ? t.notInformed : `${totals.distanceKm.toFixed(2)} km`,
    '{{PACE_MEDIO}}':
      totals.avgPaceSecondsPerKm == null
        ? t.notInformed
        : `${totals.avgPaceLabel} min/km`,
    '{{FC_MEDIA}}': totals.avgHeartRate == null ? t.notInformed : `${totals.avgHeartRate} bpm`,
    '{{FC_MAXIMA}}': totals.maxHeartRate == null ? t.notInformed : `${totals.maxHeartRate} bpm`,
    '{{DESNIVEL_POSITIVO}}':
      totals.ascentMeters == null ? t.notInformed : `${totals.ascentMeters} m`,
    '{{TENIS_UTILIZADO}}': orUninformed(feedback.tenis, t.notInformed),
    '{{FONTE_FC}}': orUninformed(feedback.fonteFc, t.notInformed),
    '{{CLIMA}}': orUninformed(feedback.clima, t.notInformed),
    '{{TERRENO}}': orUninformed(feedback.terreno, t.notInformed),
    '{{HORARIO}}': timeOfDay(startTime, t.notInformed),
    '{{RPE_PERCEBIDO}}': rpeLabel(feedback.rpePercebido, t.notInformed),
    '{{RESPIRACAO}}': orUninformed(feedback.respiracao, t.notInformed),
    '{{SENSACAO_MUSCULAR}}': orUninformed(feedback.sensacaoMuscular, t.notInformed),
    '{{ENERGIA_FINAL}}': orUninformed(feedback.energiaFinal, t.notInformed),
    '{{DOR_DESCONFORTO}}': orNoneReported(feedback.dorDesconforto, t.noneReported),
    '{{FEEDBACK}}': orUninformed(feedback.feedbackLivre, t.notInformed),
    '{{ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI}}': buildLapsTable(
      Array.isArray(summary.laps) ? summary.laps : [],
      t
    ),
  };
}

function buildTemplate(t) {
  const instructionBlock = t.instructions
    .map((item, index) => {
      const lines = [`${index + 1}. ${item.text}`];
      for (const bullet of item.bullets ?? []) {
        lines.push(`   - ${bullet}`);
      }
      return lines.join('\n');
    })
    .join('\n');

  return [
    t.intro1,
    '',
    t.intro2,
    '',
    t.sectionPlanned,
    '',
    `${t.fieldDate}: {{DATA}}`,
    `${t.fieldWeekday}: {{DIA_SEMANA}}`,
    `${t.fieldType}: {{TIPO_TREINO}}`,
    `${t.fieldPlanned}: {{TREINO_PLANEJADO}}`,
    `${t.fieldTargetHr}: {{FC_ALVO}}`,
    `${t.fieldTargetRpe}: {{RPE_ALVO}}`,
    `${t.fieldShoes}: {{TENIS}}`,
    '',
    t.sectionRealized,
    '',
    `${t.fieldTotalDuration}: {{DURACAO}}`,
    `${t.fieldTotalDistance}: {{DISTANCIA}}`,
    `${t.fieldAvgPace}: {{PACE_MEDIO}}`,
    `${t.fieldAvgHr}: {{FC_MEDIA}}`,
    `${t.fieldMaxHr}: {{FC_MAXIMA}}`,
    `${t.fieldElevation}: {{DESNIVEL_POSITIVO}}`,
    `${t.fieldShoesUsed}: {{TENIS_UTILIZADO}}`,
    '',
    t.hrSourceLabel,
    '{{FONTE_FC}}',
    '',
    t.conditionsLabel,
    `${t.fieldTempWeather}: {{CLIMA}}`,
    `${t.fieldTerrain}: {{TERRENO}}`,
    `${t.fieldTimeOfDay}: {{HORARIO}}`,
    '',
    t.perceptionLabel,
    `${t.fieldRpePerceived}: {{RPE_PERCEBIDO}}`,
    `${t.fieldBreathing}: {{RESPIRACAO}}`,
    `${t.fieldMuscleFeel}: {{SENSACAO_MUSCULAR}}`,
    `${t.fieldEndEnergy}: {{ENERGIA_FINAL}}`,
    '',
    t.discomfortLabel,
    '{{DOR_DESCONFORTO}}',
    '',
    t.freeFeedbackLabel,
    '{{FEEDBACK}}',
    '',
    t.sectionDetailed,
    '',
    '{{ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI}}',
    '',
    t.instructionsTitle,
    '',
    instructionBlock,
    '',
    t.outro,
  ].join('\n');
}

const PROMPT_TEMPLATE = buildTemplate(MESSAGES[DEFAULT_LANGUAGE].prompt);

function generateMarkdown(summary, feedback = {}, lang = DEFAULT_LANGUAGE) {
  const t = MESSAGES[normalizeLanguage(lang)].prompt;
  const values = buildValues(summary ?? {}, feedback, t);
  return buildTemplate(t).replace(/\{\{[A-Z_]+\}\}/g, (token) => values[token]);
}

module.exports = {
  PROMPT_TEMPLATE,
  generateMarkdown,
  escapeCell,
  formatMetric,
};
