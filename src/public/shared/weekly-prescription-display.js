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
        rpe: null,
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
      const rpe = effort[1].match(/(?:^|;\s*)RPE\s+([1-5])\/5\b/i);
      current.rpe = rpe ? Number(rpe[1]) : null;
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
  } = {},
) {
  const pt = language === 'pt-BR';
  const phases = parseMaterializedPrescription(details);
  const rpeParts = phases
    .filter((phase) => phase.rpe !== null)
    .map((phase) => [phase.phase, phase.rpe]);
  const recoveryRpes = phases.flatMap((phase) => {
    const match = phase.recovery.match(/(?:^|;\s*)RPE\s+([1-5])\/5\b/i);
    return match ? [Number(match[1])] : [];
  });
  let rpe;
  if (rpeParts.length || recoveryRpes.length) {
    const grouped = new Map();
    for (const [phase, value] of rpeParts) grouped.set(phase, [...(grouped.get(phase) || []), value]);
    const warm = grouped.get('warmup') || [];
    const cool = grouped.get('cooldown') || [];
    const labels = pt
      ? {
          warmup: 'Aquecimento',
          main: 'Principal',
          cooldown: 'Desaquecimento',
        }
      : { warmup: 'Warm-up', main: 'Main', cooldown: 'Cool-down' };
    const parts = [];
    const valuesText = (values) => unique(values).map((value) => `${value}/5`).join(', ');
    if (grouped.has('main')) parts.push(`${labels.main}: ${valuesText(grouped.get('main'))}`);
    if (
      warm.length &&
      cool.length &&
      unique(warm).join() === unique(cool).join()
    ) {
      parts.push(
        `${pt ? 'Aquecimento e desaquecimento' : 'Warm-up and cool-down'}: ${valuesText(warm)}`,
      );
    } else {
      if (warm.length) parts.push(`${labels.warmup}: ${valuesText(warm)}`);
      if (cool.length) parts.push(`${labels.cooldown}: ${valuesText(cool)}`);
    }
    if (recoveryRpes.length)
      parts.push(`${pt ? 'Recuperação' : 'Recovery'}: ${valuesText(recoveryRpes)}`);
    rpe = parts.join(' · ');
  } else if (fallbackRpe != null && fallbackRpe !== '') rpe = `${fallbackRpe}/5`;
  else {
    const effort = phases
      .map((phase) =>
        phase.effort
          .replace(
            /;\s*(?:RPE [1-5]\/5|(?:FC alvo|Target HR):[^;]+|(?:ritmo-alvo|target pace) [^;]+)/gi,
            '',
          )
          .trim(),
      )
      .filter(Boolean);
    rpe = unique(effort).join(' · ') || (pt ? 'Orientado por esforço e respiração.' : 'Guided by effort and breathing.');
  }
  const hrByPhase = new Map();
  for (const phase of phases) {
    if (!phase.targetHr) continue;
    hrByPhase.set(phase.phase, [
      ...(hrByPhase.get(phase.phase) || []),
      phase.targetHr,
    ]);
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
