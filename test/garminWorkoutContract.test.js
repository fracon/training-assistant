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
  assert.equal(previewPrescription(p).expanded_step_count, 10, 'legacy preview count includes repeat, intervals, and the three non-final recoveries');
  assert.match(prescriptionFingerprint(p), /^[a-f0-9]{64}$/);
  assert.equal(MAX_STEPS, 80);
});

test('version 3 requires explicit recovery for repeat groups and counts the selected final recovery policy', () => {
  const prescription = sample();
  prescription.version = 3;
  prescription.steps[1].skip_last_rest_step = true;
  const validated = validatePrescription(prescription);
  const preview = previewPrescription(validated);
  assert.equal(validated.version, 3);
  assert.equal(preview.total_time_seconds, 600 + (300 * 4) + (120 * 3) + 600);
  assert.equal(preview.expanded_step_count, 1 + 1 + 4 + 3 + 1);
  prescription.steps[1].skip_last_rest_step = false;
  assert.equal(previewPrescription(prescription).total_time_seconds, 600 + (300 * 4) + (120 * 4) + 600);
  // Keep the legacy v2 shape valid so this reaches the v3 required-recovery rule.
  prescription.steps[1].skip_last_rest_step = true;
  delete prescription.steps[1].recovery;
  assert.throws(() => validatePrescription(prescription), GarminWorkoutContractError);
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
  assert.equal(preview.distance_complete, false);
  assert.equal(preview.estimated_duration_seconds, 600 + 4 * 300 + 4 * 120 + 600);
});

test('version 2 repeated interval with no recovery omits recovery instead of emitting a zero-duration step', () => {
  const prescription = { version: 2, sport: 'running', name: 'Two by easy run', steps: [
    { id: 'repeat', kind: 'repeat', repetitions: 2, skip_last_rest_step: true,
      interval: { end: { type: 'time', value: 180 }, target: { type: 'none' } } },
  ] };
  assert.deepEqual(validatePrescription(prescription), prescription);
  assert.equal(previewPrescription(prescription).estimated_duration_seconds, 360);
});

test('version 2 counts distance-based recovery in aggregate distance without inventing time', () => {
  const prescription = { version: 2, sport: 'running', name: 'Distance recoveries', steps: [
    { id: 'repeat', kind: 'repeat', repetitions: 3, skip_last_rest_step: true,
      interval: { end: { type: 'distance', value: 1000 }, target: { type: 'none' } },
      recovery: { end: { type: 'distance', value: 200 }, target: { type: 'none' } } },
  ] };
  const preview = previewPrescription(prescription);
  assert.equal(preview.total_distance_meters, 3400);
  assert.equal(preview.total_time_seconds, 0);
  assert.equal(preview.duration_complete, false);
  assert.equal(preview.distance_complete, true);
  assert.equal(preview.estimated_duration_seconds, null);
});

test('preview marks a mixed time and distance prescription as partial in both dimensions', () => {
  const prescription = { version: 2, sport: 'running', name: 'Mixed units', steps: [
    { id: 'distance', kind: 'warmup', end: { type: 'distance', value: 1500 }, target: { type: 'none' } },
    { id: 'time', kind: 'run', end: { type: 'time', value: 600 }, target: { type: 'none' } },
  ] };
  const preview = previewPrescription(prescription);
  assert.equal(preview.total_distance_meters, 1500);
  assert.equal(preview.total_time_seconds, 600);
  assert.equal(preview.distance_complete, false);
  assert.equal(preview.duration_complete, false);
  assert.equal(preview.estimated_duration_seconds, null);
});

test('version 2 validates stage placement and requires a running step before standalone recovery', () => {
  const run = { id: 'run', kind: 'run', end: { type: 'time', value: 60 }, target: { type: 'none' } };
  const recovery = { id: 'rest', kind: 'recovery', end: { type: 'time', value: 30 }, target: { type: 'none' } };
  const cooldown = { id: 'cool', kind: 'cooldown', end: { type: 'time', value: 60 }, target: { type: 'none' } };
  const warmup = { id: 'warm', kind: 'warmup', end: { type: 'time', value: 60 }, target: { type: 'none' } };
  const repeat = { id: 'repeat', kind: 'repeat', repetitions: 2, skip_last_rest_step: true,
    interval: { end: { type: 'time', value: 60 }, target: { type: 'none' } } };
  for (const steps of [
    [cooldown, run],
    [run, warmup],
    [recovery, run],
  ]) {
    assert.throws(() => validatePrescription({ version: 2, sport: 'running', name: 'Invalid order', steps }), GarminWorkoutContractError);
  }
  assert.doesNotThrow(() => validatePrescription({ version: 2, sport: 'running', name: 'Recovery in sequence', steps: [run, recovery, { ...run, id: 'run2' }] }));
  assert.doesNotThrow(() => validatePrescription({ version: 2, sport: 'running', name: 'Final recovery', steps: [run, recovery] }));
  assert.doesNotThrow(() => validatePrescription({ version: 2, sport: 'running', name: 'Recovery after repeats', steps: [repeat, recovery, run] }));
  assert.doesNotThrow(() => validatePrescription({ version: 2, sport: 'running', name: 'Recovery before repeats', steps: [run, recovery, repeat] }));
  const repeatWithoutRecoveryButWithoutSkip = { version: 2, sport: 'running', name: 'Missing recovery', steps: [
    { id: 'repeat', kind: 'repeat', repetitions: 2, skip_last_rest_step: false,
      interval: { end: { type: 'time', value: 60 }, target: { type: 'none' } } },
  ] };
  assert.throws(() => validatePrescription(repeatWithoutRecoveryButWithoutSkip), GarminWorkoutContractError);
});

test('prescription diagnostics keep the stable error code while distinguishing actionable contract limits', () => {
  const run = (id, end = { type: 'time', value: 60 }) => ({ id, kind: 'run', end, target: { type: 'none' } });
  const expectReason = (prescription, reason, expected = {}) => {
    assert.throws(() => validatePrescription(prescription), (error) => {
      assert.equal(error.message, 'invalid_prescription');
      assert.equal(error.code, 'invalid_prescription');
      assert.equal(error.diagnostic.reason, reason);
      for (const [key, value] of Object.entries(expected)) assert.equal(error.diagnostic[key], value);
      return true;
    });
  };
  expectReason({ version: 3, sport: 'running', name: 'Step cap', steps: [run('long', { type: 'time', value: 7201 })] },
    'step_duration_limit', { step_id: 'long', actual: 7201, maximum: 7200, unit: 'seconds' });
  expectReason({ version: 3, sport: 'running', name: 'Total cap', steps: Array.from({ length: 13 }, (_, index) => run(`t${index}`, { type: 'time', value: 7200 })) },
    'total_duration_limit', { actual: 93600, maximum: 86400 });
  expectReason({ version: 3, sport: 'running', name: 'Distance cap', steps: [
    run('a', { type: 'distance', value: 100000 }), run('b', { type: 'distance', value: 1 }),
  ] }, 'distance_limit', { actual: 100001, maximum: 100000, unit: 'meters' });
  expectReason({ version: 3, sport: 'running', name: 'Distance step cap', steps: [run('long-distance', { type: 'distance', value: 100001 })] },
    'distance_limit', { step_id: 'long-distance', actual: 100001, maximum: 100000, unit: 'meters' });
  const many = Array.from({ length: 13 }, (_, index) => ({ id: `r${index}`, kind: 'repeat', repetitions: 2,
    skip_last_rest_step: true, interval: { end: { type: 'time', value: 60 }, target: { type: 'none' } },
    recovery: { end: { type: 'time', value: 30 }, target: { type: 'none' } } }));
  expectReason({ version: 3, sport: 'running', name: 'Step count', steps: many },
    'expanded_steps_limit', { actual: 52, maximum: 50 });
  expectReason({ version: 3, sport: 'running', name: 'Position', steps: [
    { id: 'warm', kind: 'warmup', end: { type: 'time', value: 60 }, target: { type: 'none' } },
    { id: 'recovery', kind: 'recovery', end: { type: 'time', value: 30 }, target: { type: 'none' } }, run('run'),
  ] }, 'step_position_invalid', { step_id: 'recovery', requirement: 'after_running_step' });
  const target = { type: 'pace', unit: 'min_per_km', slower_seconds: 90, faster_seconds: 60 };
  expectReason({ version: 3, sport: 'running', name: 'Bad target', steps: [{ ...run('target'), target }] }, 'target_invalid', { step_id: 'target', field: 'target' });
  expectReason({ version: 3, sport: 'running', name: 'Missing target', steps: [{ ...run('target'), target: null }] }, 'target_invalid', { step_id: 'target', field: 'target' });
  expectReason({ version: 3, sport: 'running', name: 'Bad repeats', steps: [{ id: 'repeat', kind: 'repeat', repetitions: 1,
    skip_last_rest_step: true, interval: { end: { type: 'time', value: 60 }, target: { type: 'none' } },
    recovery: { end: { type: 'time', value: 30 }, target: { type: 'none' } } }] },
  'repetition_count_invalid', { step_id: 'repeat', actual: 1, minimum: 2, maximum: 20 });
});

test('v3 allows an explicit recovery after a run before cooldown or as the final step and previews it intact', () => {
  const warmup = { id: 'warm', kind: 'warmup', end: { type: 'time', value: 600 }, target: { type: 'none' } };
  const run = { id: 'run', kind: 'run', end: { type: 'time', value: 7200 }, target: { type: 'none' } };
  const recovery = { id: 'rest', kind: 'recovery', end: { type: 'time', value: 180 }, target: { type: 'none' } };
  const cooldown = { id: 'cool', kind: 'cooldown', end: { type: 'time', value: 600 }, target: { type: 'none' } };
  for (const steps of [[warmup, run, recovery, cooldown], [warmup, run, recovery]]) {
    const prescription = { version: 3, sport: 'running', name: 'Easy with recovery', steps };
    assert.doesNotThrow(() => validatePrescription(prescription));
    const preview = previewPrescription(prescription);
    assert.deepEqual(preview.steps.map((step) => step.kind), steps.map((step) => step.kind));
    assert.equal(preview.expanded_step_count, steps.length);
    assert.equal(preview.estimated_duration_seconds, steps.reduce((sum, step) => sum + step.end.value, 0));
  }
  const fixture = previewPrescription({ version: 3, sport: 'running', name: 'Easy with recovery',
    steps: [warmup, run, recovery, cooldown] });
  assert.equal(fixture.estimated_duration_seconds, 8580);
  assert.deepEqual(fixture.steps.map((step) => step.kind), ['warmup', 'run', 'recovery', 'cooldown']);
  assert.deepEqual(fixture.steps[2], { order: 3, ...recovery });
});

test('version 2 includes the final recovery when requested and repeats its totals consistently', () => {
  const prescription = { version: 2, sport: 'running', name: 'Keep last recovery', steps: [
    { id: 'repeat', kind: 'repeat', repetitions: 2, skip_last_rest_step: false,
      interval: { end: { type: 'time', value: 60 }, target: { type: 'none' } },
      recovery: { end: { type: 'time', value: 30 }, target: { type: 'none' } } },
  ] };
  const preview = previewPrescription(prescription);
  assert.equal(preview.total_time_seconds, 180);
  assert.equal(preview.expanded_step_count, 5);
  assert.equal(preview.duration_complete, true);
});

test('version 2 rejects malformed identity, step shape, repeat bounds and aggregate limits', () => {
  const run = () => ({ id: 'run', kind: 'run', end: { type: 'time', value: 60 }, target: { type: 'none' } });
  const repeat = () => ({ id: 'repeat', kind: 'repeat', repetitions: 2, skip_last_rest_step: true,
    interval: { end: { type: 'time', value: 60 }, target: { type: 'none' } } });
  const cases = [
    null,
    [],
    { version: 4, sport: 'running', name: 'wrong version', steps: [run()] },
    { version: 2, sport: 'cycling', name: 'wrong sport', steps: [run()] },
    { version: 2, sport: 'running', name: 7, steps: [run()] },
    { version: 2, sport: 'running', name: 'x'.repeat(33), steps: [run()] },
    { version: 2, sport: 'running', name: 'Bad/name', steps: [run()] },
    { version: 2, sport: 'running', name: 'Missing steps', steps: [] },
    { version: 2, sport: 'running', name: 'Too many steps', steps: Array.from({ length: 51 }, (_, i) => ({ ...run(), id: `s${i}` })) },
    { version: 2, sport: 'running', name: 'Null step', steps: [null] },
    { version: 2, sport: 'running', name: 'Array step', steps: [[]] },
    { version: 2, sport: 'running', name: 'Bad id', steps: [{ ...run(), id: 'bad id' }] },
    { version: 2, sport: 'running', name: 'Duplicate ids', steps: [run(), { ...run(), kind: 'run' }] },
    { version: 2, sport: 'running', name: 'Unknown kind', steps: [{ ...run(), kind: 'sprint' }] },
    { version: 2, sport: 'running', name: 'Extra run key', steps: [{ ...run(), extra: true }] },
    { version: 2, sport: 'running', name: 'Invalid end', steps: [{ ...run(), end: { type: 'open' } }] },
    { version: 2, sport: 'running', name: 'No run', steps: [{ ...run(), kind: 'warmup' }] },
  ];
  const malformedRepeat = (change) => { const step = repeat(); change(step); return { version: 2, sport: 'running', name: 'Bad repeat', steps: [step] }; };
  cases.push(
    malformedRepeat((step) => { step.extra = true; }),
    malformedRepeat((step) => { step.repetitions = 1; }),
    malformedRepeat((step) => { step.repetitions = 21; }),
    malformedRepeat((step) => { step.skip_last_rest_step = 1; }),
    malformedRepeat((step) => { step.interval.end.value = 0; }),
    malformedRepeat((step) => { step.interval.extra = true; }),
    { version: 2, sport: 'running', name: 'Too many expanded steps', steps: [
      { ...repeat(), repetitions: 20, recovery: { end: { type: 'time', value: 1 }, target: { type: 'none' } }, skip_last_rest_step: false },
      { ...repeat(), id: 'repeat2', repetitions: 20, recovery: { end: { type: 'time', value: 1 }, target: { type: 'none' } }, skip_last_rest_step: false },
    ] },
    { version: 2, sport: 'running', name: 'Too much duration', steps: Array.from({ length: 13 }, (_, index) => ({
      ...run(), id: `time${index}`, end: { type: 'time', value: 7200 },
    })) },
    { version: 2, sport: 'running', name: 'Too much distance', steps: [{ ...run(), end: { type: 'distance', value: 100000 } }, { ...run(), id: 'run2', end: { type: 'distance', value: 1 } }] },
    { version: 2, sport: 'running', name: 'Duplicate warmup', steps: [{ ...run(), kind: 'warmup' }, { ...run(), id: 'warm2', kind: 'warmup' }, run()] },
    { version: 2, sport: 'running', name: 'Duplicate cooldown', steps: [run(), { ...run(), id: 'cool1', kind: 'cooldown' }, { ...run(), id: 'cool2', kind: 'cooldown' }] },
  );
  cases.forEach((prescription, index) => assert.throws(() => validatePrescription(prescription), GarminWorkoutContractError, `case ${index}`));
});

test('version 2 preserves independent blocks, targets and optional recovery in preview', () => {
  const prescription = { version: 2, sport: 'running', name: 'Mixed run', steps: [
    { id: 'warmup', kind: 'warmup', end: { type: 'time', value: 300 },
      target: { type: 'heart_rate', mode: 'absolute', lower_bpm: 110, upper_bpm: 130 } },
    { id: 'easy', kind: 'run', end: { type: 'time', value: 600 }, target: { type: 'none' } },
    { id: 'reps', kind: 'repeat', repetitions: 3, skip_last_rest_step: true,
      interval: { end: { type: 'time', value: 180 }, target: { type: 'pace', unit: 'min_per_km', slower_seconds: 330, faster_seconds: 300 } },
      recovery: { end: { type: 'time', value: 120 }, target: { type: 'heart_rate', mode: 'absolute', lower_bpm: 100, upper_bpm: 120 } } },
    { id: 'finish', kind: 'run', end: { type: 'distance', value: 1000 }, target: { type: 'none' } },
    { id: 'cooldown', kind: 'cooldown', end: { type: 'distance', value: 500 }, target: { type: 'none' } },
  ] };
  const preview = previewPrescription(prescription);
  assert.equal(preview.steps.length, 5);
  assert.deepEqual(preview.steps[2].recovery, prescription.steps[2].recovery);
  assert.equal(preview.steps[2].skip_last_rest_step, true);
  assert.equal(preview.total_time_seconds, 300 + 600 + 540 + 240);
  assert.equal(preview.total_distance_meters, 1500);
  assert.equal(preview.estimated_duration_seconds, null);
  assert.equal(preview.expanded_step_count, 10);
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
  assert.equal(previewPrescription(p).distance_complete, false, 'an open stage prevents claiming a complete distance');
});

test('distance-only legacy prescription has a complete distance total', () => {
  const prescription = sample();
  prescription.steps = [{ id: 'run', kind: 'run', end: { type: 'distance', value: 5000 }, target: { type: 'none' } }];
  const preview = previewPrescription(prescription);
  assert.equal(preview.distance_complete, true);
  assert.equal(preview.total_distance_meters, 5000);
  assert.equal(preview.duration_complete, false);
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
    { ...sample(), name: ' ' }, { ...sample(), name: 'x'.repeat(33) }, { ...sample(), name: 4 },
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
