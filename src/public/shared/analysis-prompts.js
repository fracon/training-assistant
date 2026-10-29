import { formatDate as formatLocalizedDate, formatWeekday } from './date.js';
import { translate } from './i18n.js';
import { formatDistance, formatPaceFromMetric } from './units.js';

// Generic placeholder interpolation only. The external prompt text is never
// bundled in this public module.
export function buildAnalysisPrompt(template, values = {}) {
  return String(template ?? '').replace(/{{([A-Z0-9_]+)}}/g, (placeholder, key) => {
    const value = values[key];
    if (value === undefined || value === null || String(value).trim() === '') return '—';
    return String(value);
  });
}

// Presentation-only helpers. External prompt templates and construction live in
// the private server module so regular accounts never receive prompt content.
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

export function formatCadence(value) {
  return !Number.isFinite(value) || value < 0 ? '-' : String(value);
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

// Pure display helper for locally persisted FIT laps; contains no prompt copy.
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
    const cadence = formatCadence(lap.avgCadenceSpm);
    const stepType = formatLapType(lap.stepType, preferences.language, preferences.messages);
    const ascent = lap.ascentMeters != null ? String(lap.ascentMeters) : '-';
    const paceLabel = pace === '-' ? `- min/${distanceUnit}` : formatPaceFromMetric(pace, distanceUnit);
    const distanceValue = distance === '-' ? '-' : formatDistance(distance, distanceUnit).replace(/\s(km|mi)$/, '');
    return `| ${lap.lap} | ${stepType} | ${distanceValue} ${distanceUnit} | ${duration} | ${paceLabel} | ${hr} | ${cadence} | ${ascent} |`;
  });
  return [header, separator, ...rows].join('\n');
}

export const HR_SOURCE_LABEL_KEYS = {
  chest_strap: 'session.hrSourceStrap', optical_watch: 'session.hrSourceOptical', none: 'session.hrSourceNone',
};
export const TERRAIN_LABEL_KEYS = {
  asphalt: 'terrain.asphalt', trail: 'terrain.trail', track: 'terrain.track', treadmill: 'terrain.treadmill', mixed: 'terrain.mixed',
};
export const BREATHING_LABEL_KEYS = {
  controlled: 'breathing.controlled', panting: 'breathing.panting', heavy: 'breathing.heavy',
};
export const MUSCLE_LABEL_KEYS = {
  light: 'muscle.light', normal: 'muscle.normal', heavy: 'muscle.heavy', fatigued: 'muscle.fatigued',
};
export const ENERGY_LABEL_KEYS = {
  surplus: 'energy.surplus', limit: 'energy.limit', exhausted: 'energy.exhausted',
};
