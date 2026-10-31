'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GarminWorkoutContractError, MAX_STEPS, paceBoundsMps, prescriptionFingerprint, previewPrescription, validatePrescription } = require('../src/garmin-workout-contract');

function sample(target = { type: 'none' }) {
  return { version: 1, sport: 'running', name: 'Tempo session', steps: [
    { id: 'warm', kind: 'warmup', end: { type: 'time', value: 600 }, target: { type: 'none' } },
    { id: 'repeat', kind: 'repeat', repetitions: 4,
      interval: { end: { type: 'time', value: 300 }, target },
      recovery: { end: { type: 'time', value: 120 }, target: { type: 'none' } } },
    { id: 'cool', kind: 'cooldown', end: { type: 'time', value: 600 }, target: { type: 'none' } },
  ] };
}

test('prescription validation preserves structured repeat order and preview', () => {
  const p = validatePrescription(sample());
  assert.deepEqual(p.steps.map((step) => step.id), ['warm', 'repeat', 'cool']);
  assert.equal(previewPrescription(p).steps[1].repetitions, 4);
  assert.equal(previewPrescription(p).steps[1].end.value, 300);
  assert.match(prescriptionFingerprint(p), /^[a-f0-9]{64}$/);
  assert.equal(MAX_STEPS, 80);
});

test('repeat preview preserves recovery prescription and final recovery policy', () => {
  const prescription = sample();
  prescription.steps[1].skip_last_rest_step = true;
  prescription.steps[1].recovery.target = { type: 'heart_rate', mode: 'absolute', lower_bpm: 120, upper_bpm: 140 };
  const preview = previewPrescription(prescription);
  assert.deepEqual(preview.steps[1].recovery, prescription.steps[1].recovery);
  assert.equal(preview.steps[1].skip_last_rest_step, true);
  assert.equal(preview.total_time_seconds, 600 + 4 * 300 + 3 * 120 + 600);
  assert.equal(preview.estimated_duration_seconds, 2760);
});

test('timed repeat includes the final recovery when that Garmin policy is explicit', () => {
  const prescription = sample();
  prescription.steps[1].skip_last_rest_step = false;
  const preview = previewPrescription(prescription);
  assert.equal(preview.duration_complete, true);
  assert.equal(preview.estimated_duration_seconds, 600 + 4 * 300 + 4 * 120 + 600);
});

test('supports positive time and distance steps and open laps in the contract', () => {
  const p = sample();
  p.steps = [
    { id: 'distance', kind: 'run', end: { type: 'distance', value: 1000 }, target: { type: 'none' } },
    { id: 'open', kind: 'open', end: { type: 'open' }, target: { type: 'none' } },
  ];
  assert.equal(validatePrescription(p).steps.length, 2);
  assert.equal(previewPrescription(p).steps[0].end.type, 'distance');
  assert.equal(previewPrescription(p).estimated_duration_seconds, null);
});

test('counts repeated distance intervals against the aggregate distance limit', () => {
  const prescription = sample();
  prescription.steps[1].interval.end = { type: 'distance', value: 1000 };
  const valid = validatePrescription(prescription);
  assert.equal(valid.steps[1].interval.end.value, 1000);
  prescription.steps[1].interval.end.value = 26000;
  assert.throws(() => validatePrescription(prescription), GarminWorkoutContractError);
});

test('distance repeats and final recovery are counted exactly without inventing duration', () => {
  const prescription = sample();
  const repeat = prescription.steps[1];
  repeat.interval.end = { type: 'distance', value: 1000 };
  repeat.recovery.end = { type: 'time', value: 90 };
  repeat.skip_last_rest_step = false;
  const preview = previewPrescription(prescription);
  assert.equal(preview.total_distance_meters, 4000);
  assert.equal(preview.total_time_seconds, 600 + 4 * 90 + 600);
  assert.equal(preview.duration_complete, false);
  assert.equal(preview.estimated_duration_seconds, null);
  assert.equal(preview.steps[1].skip_last_rest_step, false);
});

test('validates absolute heart rate and pace bounds with correct speed order', () => {
  const hr = sample({ type: 'heart_rate', mode: 'absolute', lower_bpm: 140, upper_bpm: 160 });
  assert.equal(validatePrescription(hr).steps[1].interval.target.upper_bpm, 160);
  const pace = { type: 'pace', unit: 'min_per_km', slower_seconds: 360, faster_seconds: 300 };
  const bounds = paceBoundsMps(pace);
  assert.ok(bounds.lower_mps < bounds.upper_mps);
  assert.equal(paceBoundsMps({ type: 'none' }), null);
  assert.ok(paceBoundsMps({ type: 'pace', unit: 'min_per_mile', slower_seconds: 600, faster_seconds: 500 }).upper_mps > 0);
});

test('friendly PT workout names retain accented letters and normalize canonically', () => {
  const prescription = sample();
  // En dash is intentionally not part of the connector-safe title alphabet;
  // the normal product separator remains an ordinary space/hyphen.
  prescription.name = 'Corrida ra\u0301pida - intervalos';
  const valid = validatePrescription(prescription);
  assert.equal(valid.name, 'Corrida rápida - intervalos');
  prescription.name = 'Corrida\nmaliciosa';
  assert.throws(() => validatePrescription(prescription), GarminWorkoutContractError);
});

test('rejects malformed prescriptions, duplicate IDs, bad targets, and limits', () => {
  const cases = [null, {}, { ...sample(), version: 2 }, { ...sample(), sport: 'cycling' },
    { ...sample(), name: ' ' }, { ...sample(), name: 'x'.repeat(33) },
    { ...sample(), unexpected: true }, { ...sample(), steps: [{ ...sample().steps[0], extra: 'ignored' }] },
    { ...sample(), steps: [{ ...sample().steps[0], end: { type: 'time', value: 10, extra: true } }] },
    { ...sample(), steps: [{ ...sample().steps[0], target: { type: 'none', extra: true } }] },
    { ...sample(), steps: [{ id: 'open', kind: 'open', end: null, target: { type: 'none' } }] },
    { ...sample(), steps: [{ id: 'open', kind: 'open', end: { type: 'open', value: 1 }, target: { type: 'none' } }] },
    { ...sample(), steps: [{ id: 'open', kind: 'open', end: { type: 'time' }, target: { type: 'none' } }] },
    { ...sample(), steps: [{ ...sample().steps[0], target: null }] },
    { ...sample(), steps: [{ ...sample().steps[0], target: [] }] },
    { ...sample(), steps: [] }, { ...sample(), steps: [{ ...sample().steps[0], id: 'same' }, { ...sample().steps[0], id: 'same' }] },
    { ...sample(), steps: [{ ...sample().steps[0], end: { type: 'time', value: 0 } }] },
    { ...sample(), steps: [{ ...sample().steps[0], target: { type: 'heart_rate', mode: 'zone', zone: 3 } }] },
    { ...sample(), steps: [{ ...sample().steps[0], target: { type: 'pace', unit: 'min_per_km', slower_seconds: 240, faster_seconds: 300 } }] },
    { ...sample(), steps: Array.from({ length: MAX_STEPS + 1 }, (_, index) => ({ id: `s${index}`, kind: 'open', end: { type: 'open' }, target: { type: 'none' } })) },
  ];
  for (const item of cases) assert.throws(() => validatePrescription(item), GarminWorkoutContractError);
  assert.equal(paceBoundsMps({ type: 'heart_rate', mode: 'absolute', lower_bpm: 50, upper_bpm: 50 }), null);
});

test('rejects impossible repetitions, end conditions, and cumulative bounds', () => {
  const repetitions = sample(); repetitions.steps[1].repetitions = 1;
  assert.throws(() => validatePrescription(repetitions), /invalid_prescription/);
  const repeatDistance = sample(); repeatDistance.steps[1].interval.end = { type: 'distance', value: 0 };
  assert.throws(() => validatePrescription(repeatDistance), /invalid_prescription/);
  const huge = sample(); huge.steps[0].end.value = 7200; huge.steps[1].repetitions = 30; huge.steps[1].interval.end.value = 7200;
  assert.throws(() => validatePrescription(huge), /invalid_prescription/);
  const distance = sample(); distance.steps = [{ id: 'far', kind: 'run', end: { type: 'distance', value: 100001 }, target: { type: 'none' } }];
  assert.throws(() => validatePrescription(distance), /invalid_prescription/);
});
