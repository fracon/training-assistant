'use strict';

const MAX_STEPS = 80;
const MAX_TOTAL_SECONDS = 24 * 60 * 60;
const MAX_DISTANCE_METERS = 100000;
const MAX_NAME_LENGTH = 32;

class GarminWorkoutContractError extends Error {
  constructor(code) { super(code); this.name = 'GarminWorkoutContractError'; this.code = code; }
}

function fail() { throw new GarminWorkoutContractError('invalid_prescription'); }

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validatePrescription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !hasOnlyKeys(value, ['version', 'sport', 'name', 'steps'])
      || value.version !== 1 || value.sport !== 'running'
      || typeof value.name !== 'string' || value.name.trim().length < 1
      || value.name.trim().length > MAX_NAME_LENGTH
      || !/^[A-Za-z0-9 _.-]+$/.test(value.name.trim())
      || !Array.isArray(value.steps) || value.steps.length < 1
      || value.steps.length > MAX_STEPS) fail();
  const ids = new Set();
  let totalSeconds = 0;
  let totalDistance = 0;
  const steps = value.steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)
        || !hasOnlyKeys(step, step.kind === 'repeat'
          ? ['id', 'kind', 'repetitions', 'interval', 'recovery']
          : ['id', 'kind', 'end', 'target'])
        || typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(step.id)
        || ids.has(step.id) || !['warmup', 'run', 'recovery', 'cooldown', 'open', 'repeat'].includes(step.kind)) fail();
    ids.add(step.id);
    if (step.kind === 'repeat') {
      if (!Number.isInteger(step.repetitions) || step.repetitions < 2 || step.repetitions > 30
          || !step.interval || !['time', 'distance'].includes(step.interval.end?.type)
          || !step.recovery || step.recovery.end?.type !== 'time') fail();
      for (const child of [step.interval, step.recovery]) {
        if (!hasOnlyKeys(child, ['end', 'target']) || !Number.isInteger(child.end.value) || child.end.value < 1
            || child.end.value > (child.end.type === 'time' ? 7200 : MAX_DISTANCE_METERS)) fail();
        if (child.end.type === 'time') totalSeconds += child.end.value * (child === step.interval ? step.repetitions : step.repetitions - 1);
        else totalDistance += child.end.value * step.repetitions;
        validateTarget(child.target);
      }
    } else if (step.kind === 'open') {
      if (!step.end || !hasOnlyKeys(step.end, ['type']) || step.end.type !== 'open') fail();
      validateTarget(step.target);
    } else {
      if (!step.end || !hasOnlyKeys(step.end, ['type', 'value']) || !['time', 'distance'].includes(step.end.type)
          || !Number.isInteger(step.end.value) || step.end.value < 1
          || step.end.value > (step.end.type === 'time' ? 7200 : MAX_DISTANCE_METERS)) fail();
      if (step.end.type === 'time') totalSeconds += step.end.value;
      else totalDistance += step.end.value;
      validateTarget(step.target);
    }
    return JSON.parse(JSON.stringify(step));
  });
  if (totalSeconds > MAX_TOTAL_SECONDS || totalDistance > MAX_DISTANCE_METERS) fail();
  return { version: 1, sport: 'running', name: value.name.trim(), steps };
}

function validateTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) fail();
  if (target.type === 'none' && hasOnlyKeys(target, ['type'])) return;
  if (target.type === 'heart_rate' && target.mode === 'absolute'
      && hasOnlyKeys(target, ['type', 'mode', 'lower_bpm', 'upper_bpm'])
      && Number.isInteger(target.lower_bpm) && Number.isInteger(target.upper_bpm)
      && target.lower_bpm >= 40 && target.upper_bpm <= 230
      && target.lower_bpm <= target.upper_bpm) return;
  if (target.type === 'pace' && ['min_per_km', 'min_per_mile'].includes(target.unit)
      && hasOnlyKeys(target, ['type', 'unit', 'slower_seconds', 'faster_seconds'])
      && Number.isInteger(target.slower_seconds) && Number.isInteger(target.faster_seconds)
      && target.faster_seconds >= 120 && target.slower_seconds <= 1800
      && target.faster_seconds <= target.slower_seconds) return;
  fail();
}

function paceBoundsMps(target) {
  validateTarget(target);
  if (target.type !== 'pace') return null;
  const metersPerUnit = target.unit === 'min_per_mile' ? 1609.344 : 1000;
  const slower = metersPerUnit / target.slower_seconds;
  const faster = metersPerUnit / target.faster_seconds;
  return { lower_mps: Number(slower.toFixed(4)), upper_mps: Number(faster.toFixed(4)) };
}

function prescriptionFingerprint(prescription) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(JSON.stringify(validatePrescription(prescription))).digest('hex');
}

function previewPrescription(prescription) {
  const valid = validatePrescription(prescription);
  return valid.steps.map((step, index) => ({
    order: index + 1,
    kind: step.kind,
    repetitions: step.kind === 'repeat' ? step.repetitions : null,
    end: step.kind === 'repeat' ? step.interval.end : step.end,
    target: step.kind === 'repeat' ? step.interval.target : step.target,
  }));
}

module.exports = {
  GarminWorkoutContractError,
  MAX_STEPS,
  paceBoundsMps,
  prescriptionFingerprint,
  previewPrescription,
  validatePrescription,
};
