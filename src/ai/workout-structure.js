'use strict';

// Converts one validated weekly-workouts session into the canonical Garmin
// structured prescription (contract v3). The conversion is literal: it never
// invents a value, splits or truncates a step, drops repetitions, or turns RPE
// into a pace/HR target. Anything that cannot be represented faithfully is
// reported as an issue with a stable code instead of being adapted silently.
const { validatePrescription } = require('../garmin-workout-contract');
const { VERSION, LEGACY_VERSION } = require('./weekly-workouts');

const CONVERTER_VERSION = 1;
const MAX_STEP_SECONDS = 7200;
const MAX_REPETITIONS = 20;

function convertTarget(target) {
  if (target.type === 'heart_rate')
    return {
      type: 'heart_rate',
      mode: 'absolute',
      lower_bpm: target.lowerBpm,
      upper_bpm: target.upperBpm,
    };
  if (target.type === 'pace')
    return {
      type: 'pace',
      unit: 'min_per_km',
      slower_seconds: target.slowerSecondsPerKm,
      faster_seconds: target.fasterSecondsPerKm,
    };
  return { type: 'none' };
}

function nameIsValid(name) {
  try {
    validatePrescription({
      version: 3,
      sport: 'running',
      name,
      steps: [{ id: 'run-1', kind: 'run', end: { type: 'time', value: 60 }, target: { type: 'none' } }],
    });
    return true;
  } catch {
    return false;
  }
}

function convertSessionStructure(session, { name, version = VERSION } = {}) {
  const legacy = version === LEGACY_VERSION;
  const issues = [];
  const blocking = (code, details) => issues.push({ code, severity: 'blocking', ...details });
  const warning = (code, details) => issues.push({ code, severity: 'warning', ...details });
  if (!nameIsValid(name)) blocking('name_invalid', { field: 'name' });
  let runIndex = 0;
  const steps = session.prescription.map((component, index) => {
    const id = component.phase === 'main' ? `run-${++runIndex}` : component.phase;
    const where = { step_index: index, step_id: id };
    let target = { type: 'none' };
    if (legacy) {
      // v3 targets are free text or a single pace value; neither is parsed
      // or widened into a range. The step keeps no target and asks for review.
      if (component.targetHr.trim()) warning('hr_text_unstructured', { ...where, field: 'target' });
      if (component.paceTargetSecondsPerKm !== null) warning('point_pace_target', { ...where, field: 'target' });
    } else {
      target = convertTarget(component.target);
    }
    let end;
    if (component.minutes !== null) {
      end = { type: 'time', value: component.minutes * 60 };
      if (end.value > MAX_STEP_SECONDS)
        blocking('step_duration_limit', { ...where, field: 'end', actual: end.value, maximum: MAX_STEP_SECONDS, unit: 'seconds' });
    } else {
      end = { type: 'distance', value: component.distanceMeters };
    }
    if (component.phase !== 'main') return { id, kind: component.phase, end, target };
    if (component.repetitions === 1) return { id, kind: 'run', end, target };
    if (component.repetitions > MAX_REPETITIONS)
      blocking('repetition_count_invalid', { ...where, field: 'repetitions', actual: component.repetitions, maximum: MAX_REPETITIONS });
    if (component.recoveryMinutes === 0)
      blocking('zero_recovery', { ...where, field: 'recovery' });
    return {
      id,
      kind: 'repeat',
      repetitions: component.repetitions,
      interval: { end, target },
      recovery: {
        end: { type: 'time', value: component.recoveryMinutes * 60 },
        target: legacy ? { type: 'none' } : convertTarget(component.recoveryTarget),
      },
      // The narrative counts N−1 recoveries, so the last one is skipped.
      skip_last_rest_step: true,
    };
  });
  let prescription = null;
  if (!issues.some((issue) => issue.severity === 'blocking')) {
    try {
      prescription = validatePrescription({ version: 3, sport: 'running', name, steps });
    } catch (error) {
      const { reason, step_id: stepId, field, actual, maximum, unit } = error.diagnostic;
      blocking(reason, Object.fromEntries(
        Object.entries({ step_id: stepId, field, actual, maximum, unit })
          .filter(([, value]) => value !== undefined),
      ));
    }
  }
  return {
    converterVersion: CONVERTER_VERSION,
    status: !prescription ? 'incompatible' : issues.length ? 'needs_review' : 'ready',
    prescription,
    issues,
  };
}

module.exports = { CONVERTER_VERSION, convertSessionStructure };
