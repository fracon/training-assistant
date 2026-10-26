import { convertCelsius } from './units.js';

const PHASES = {
  'Aquecimento': 'warmup',
  'Warm-up': 'warmup',
  'Principal': 'main',
  'Main set': 'main',
  'Desaquecimento': 'cooldown',
  'Cool-down': 'cooldown',
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function cleanJustification(value) {
  return String(value ?? '')
    .replace(
      /\b(?:cycle_plan|availability|training|cycle|shoe|weather|profile|preferences):[A-Za-z0-9_-]+\b/gi,
      '',
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '')
    .replace(/[([]\s*[)\]]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/([,;:])(?=\s*[.!?]|$)/g, '')
    .replace(/([,;:])\s*([,;:])/g, '$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseMaterializedPrescription(details = '') {
  const phases = [];
  let current = null;
  for (const line of String(details).split(/\r?\n/)) {
    const phaseMatch = line.match(/^(Aquecimento|Warm-up|Principal|Main set|Desaquecimento|Cool-down):\s*(.*)$/);
    if (phaseMatch) {
      current = {
        phase: PHASES[phaseMatch[1]],
        label: phaseMatch[1],
        duration: phaseMatch[2],
        instruction: '',
        effort: '',
        targetHr: '',
        recovery: '',
      };
      phases.push(current);
      continue;
    }
    if (!current) continue;
    const instruction = line.match(/^(?:Execução|Execution):\s*(.*)$/);
    if (instruction) current.instruction = instruction[1];
    const effort = line.match(/^(?:Esforço|Effort):\s*(.*)$/);
    if (effort) {
      current.effort = effort[1];
      const hr = effort[1].match(/(?:^|;\s*)(?:FC alvo|Target HR):\s*([^;]+)/i);
      current.targetHr = hr?.[1]?.trim() || '';
    }
    const recovery = line.match(
      /^(?:Recuperação entre repetições|Recovery between repeats):\s*(.*)$/,
    );
    if (recovery) current.recovery = recovery[1];
  }
  return phases;
}

export function summarizePrescription(
  details,
  {
    language = 'en-US',
    fallbackRpe = null,
    fallbackHr = '',
    hrFallback = '',
    prescription = null,
  } = {},
) {
  const pt = language === 'pt-BR';
  const phases = parseMaterializedPrescription(details);
  const structuredSteps = Array.isArray(prescription) ? prescription : null;
  const mainSteps = structuredSteps
    ? structuredSteps.filter((step) => step?.phase === 'main')
    : [];
  const mainRpes = unique(
    mainSteps
      .map((step) => step.rpe)
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 5),
  ).sort((left, right) => left - right);
  const effortFallback = structuredSteps
    ? unique(
        mainSteps
          .map((step) => String(step?.effort ?? '').trim())
          .filter(Boolean),
      ).join(' · ')
    : unique(
        phases
          .filter((phase) => phase.phase === 'main')
          .map((phase) => phase.effort.trim())
          .filter(Boolean),
      ).join(' · ');
  const rpe = mainRpes.length
    ? mainRpes.length === 1
      ? `${mainRpes[0]}/5`
      : `${mainRpes[0]}–${mainRpes.at(-1)}/5`
    : effortFallback ||
      (structuredSteps
        ? pt
          ? 'Orientado por esforço e respiração.'
          : 'Guided by effort and breathing.'
        : fallbackRpe != null && fallbackRpe !== ''
          ? `${fallbackRpe}/5`
          : pt
            ? 'Orientado por esforço e respiração.'
            : 'Guided by effort and breathing.');

  const hrByPhase = new Map();
  const targets = structuredSteps
    ? structuredSteps.map((step) => [step.phase, step.targetHr])
    : phases.map((phase) => [phase.phase, phase.targetHr]);
  for (const [phase, target] of targets) {
    if (!target?.trim()) continue;
    hrByPhase.set(phase, [...(hrByPhase.get(phase) || []), target.trim()]);
  }
  const hrTargets = unique([...hrByPhase.values()].flat());
  const phaseLabels = pt
    ? {
        warmup: 'Aquecimento',
        main: 'Principal',
        cooldown: 'Desaquecimento',
      }
    : { warmup: 'Warm-up', main: 'Main', cooldown: 'Cool-down' };
  const variedHr = hrTargets.length > 1
    ? [...hrByPhase.entries()]
        .map(
          ([phase, values]) =>
            `${phaseLabels[phase]}: ${unique(values).join(', ')}`,
        )
        .join(' · ')
    : '';
  const hr =
    variedHr ||
    (hrTargets.length
      ? hrTargets[0]
      : fallbackHr ||
        hrFallback ||
        (pt
          ? 'Por esforço e respiração; sem referência de FC disponível.'
          : 'By effort and breathing; no HR reference available.'));
  return { rpe, hr, phases };
}

export function cleanWeeklyJustification(value) {
  return cleanJustification(value);
}
export function formatWeeklyWeather(
  evidence,
  {
    temperatureUnit = 'C',
    language = 'en-US',
    translate = (key) => key,
  } = {},
) {
  const pt = language === 'pt-BR';
  if (!evidence || evidence.status !== 'verified') {
    const key =
      evidence?.status === 'partial'
        ? 'aiCoach.forecastPartial'
        : 'aiCoach.forecastUnavailable';
    return translate(key);
  }
  if (
    !Number.isFinite(evidence.window?.minC) ||
    !Number.isFinite(evidence.window?.maxC)
  )
    return translate('aiCoach.forecastUnavailable');
  const unit = temperatureUnit === 'F' ? 'F' : 'C';
  const formatted = (value) => Number(convertCelsius(value, unit).toFixed(1));
  const range = `${formatted(evidence.window.minC)}–${formatted(evidence.window.maxC)} °${unit}`;
  const high = `${formatted(evidence.window.maxC)} °${unit}`;
  const codes = Array.isArray(evidence.hours)
    ? unique(
        evidence.hours
          .map((hour) =>
            Array.isArray(hour) ? hour[3] : hour?.weatherCode,
          )
          .filter(Number.isInteger),
      ).slice(0, 3)
    : [];
  const conditions = codes
    .map((code) => {
      const value = translate(`weather.${code}`);
      return value && value !== `weather.${code}`
        ? value
        : translate('weather.unknown');
    })
    .filter(Boolean);
  const extra = conditions.length ? ` · ${conditions.join(', ')}` : '';
  return pt
    ? `${range} · máxima no período: ${high}${extra}`
    : `${range} · period high: ${high}${extra}`;
}
