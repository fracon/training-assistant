'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { AiError, hash } = require('../src/ai/memory');
const weekly = require('../src/ai/weekly-workouts');
const { convertSessionStructure, CONVERTER_VERSION } = require('../src/ai/workout-structure');
const { validatePrescription } = require('../src/garmin-workout-contract');

const NONE = { type: 'none', lowerBpm: null, upperBpm: null, fasterSecondsPerKm: null, slowerSecondsPerKm: null };
const hr = (lowerBpm, upperBpm) => ({ ...NONE, type: 'heart_rate', lowerBpm, upperBpm });
const pace = (fasterSecondsPerKm, slowerSecondsPerKm) => ({ ...NONE, type: 'pace', fasterSecondsPerKm, slowerSecondsPerKm });

function step(phase, overrides = {}) {
  const repeated = phase === 'main' && (overrides.repetitions || 1) > 1;
  return {
    phase,
    repetitions: 1,
    minutes: null,
    distanceMeters: null,
    instruction: 'Run with relaxed form.',
    effort: 'Controlled breathing.',
    rpe: null,
    target: NONE,
    paceSecondsPerKm: null,
    recoveryMinutes: repeated ? 2 : null,
    recoveryGuidance: repeated ? 'Jog easily.' : null,
    recoveryRpe: null,
    recoveryTarget: repeated ? NONE : null,
    ...overrides,
  };
}
function session(prescription, sessionKind = 'easy') {
  return {
    date: '2026-10-26',
    weekday: 'monday',
    period: '08_12',
    sessionKind,
    prescription,
    shoeId: null,
    location: 'Porto, Portugal',
    weather: 'Open-Meteo verified',
    notes: '',
    justification: 'Builds on the applied plan.',
    evidence: ['cycle:cycle'],
  };
}
const legacy = (value) => ({
  ...value,
  prescription: value.prescription.map(({ target: _t, recoveryTarget: _r, ...rest }) => ({
    ...rest,
    targetHr: '',
    paceTargetSecondsPerKm: null,
  })),
});
const convert = (value, options = {}) =>
  convertSessionStructure(value, { name: 'Interval run', ...options });

const continuous = session([step('warmup', { minutes: 10 }), step('main', { minutes: 40 }), step('cooldown', { minutes: 10 })]);
const intervals = session([
  step('warmup', { minutes: 15, target: hr(120, 140) }),
  step('main', {
    repetitions: 6,
    distanceMeters: 800,
    paceSecondsPerKm: 270,
    target: pace(255, 265),
    recoveryMinutes: 2,
    recoveryTarget: hr(110, 130),
  }),
  step('cooldown', { minutes: 10 }),
], 'intervals');
const variable = session([
  step('warmup', { minutes: 12 }),
  step('main', { repetitions: 4, minutes: 3, target: hr(165, 175), recoveryMinutes: 2 }),
  step('main', { repetitions: 3, minutes: 1, target: pace(240, 250), recoveryMinutes: 1, recoveryTarget: hr(120, 135) }),
  step('main', { minutes: 15, target: hr(140, 150) }),
  step('cooldown', { distanceMeters: 2000, paceSecondsPerKm: 360 }),
], 'fartlek');
const longRun = session([
  step('warmup', { minutes: 10 }),
  step('main', { minutes: 120, target: hr(135, 145) }),
  step('main', { minutes: 30, target: hr(135, 145) }),
  step('cooldown', { minutes: 10 }),
], 'long');

test('conversion maps warm-up, runs, repeats and cool-down literally into the Garmin v3 contract', () => {
  const plain = convert(continuous, { name: 'Easy run' });
  assert.equal(plain.converterVersion, CONVERTER_VERSION);
  assert.equal(plain.status, 'ready');
  assert.deepEqual(plain.issues, []);
  assert.deepEqual(plain.prescription, {
    version: 3,
    sport: 'running',
    name: 'Easy run',
    steps: [
      { id: 'warmup', kind: 'warmup', end: { type: 'time', value: 600 }, target: { type: 'none' } },
      { id: 'run-1', kind: 'run', end: { type: 'time', value: 2400 }, target: { type: 'none' } },
      { id: 'cooldown', kind: 'cooldown', end: { type: 'time', value: 600 }, target: { type: 'none' } },
    ],
  });

  const repeat = convert(intervals);
  assert.equal(repeat.status, 'ready');
  assert.deepEqual(repeat.prescription.steps, [
    { id: 'warmup', kind: 'warmup', end: { type: 'time', value: 900 }, target: { type: 'heart_rate', mode: 'absolute', lower_bpm: 120, upper_bpm: 140 } },
    {
      id: 'run-1',
      kind: 'repeat',
      repetitions: 6,
      interval: { end: { type: 'distance', value: 800 }, target: { type: 'pace', unit: 'min_per_km', slower_seconds: 265, faster_seconds: 255 } },
      recovery: { end: { type: 'time', value: 120 }, target: { type: 'heart_rate', mode: 'absolute', lower_bpm: 110, upper_bpm: 130 } },
      skip_last_rest_step: true,
    },
    { id: 'cooldown', kind: 'cooldown', end: { type: 'time', value: 600 }, target: { type: 'none' } },
  ]);

  const mixed = convert(variable, { name: 'Fartlek' });
  assert.equal(mixed.status, 'ready');
  assert.deepEqual(mixed.prescription.steps.map((item) => [item.id, item.kind, item.repetitions ?? null]), [
    ['warmup', 'warmup', null],
    ['run-1', 'repeat', 4],
    ['run-2', 'repeat', 3],
    ['run-3', 'run', null],
    ['cooldown', 'cooldown', null],
  ]);
  assert.deepEqual(mixed.prescription.steps[4].end, { type: 'distance', value: 2000 });
  assert.deepEqual(mixed.prescription.steps[1].recovery.target, { type: 'none' });

  const long = convert(longRun, { name: 'Long run' });
  assert.equal(long.status, 'ready');
  assert.deepEqual(long.prescription.steps.slice(1, 3).map((item) => item.end.value), [7200, 1800]);
  // Every ready structure is exactly what the canonical contract accepts.
  for (const result of [plain, repeat, mixed, long])
    assert.deepEqual(validatePrescription(result.prescription), result.prescription);
});

test('RPE never becomes a pace or heart-rate target', () => {
  const effortOnly = session([
    step('warmup', { minutes: 10, rpe: 2 }),
    step('main', { repetitions: 5, minutes: 4, rpe: 4, recoveryRpe: 2 }),
    step('cooldown', { minutes: 10, rpe: 1 }),
  ]);
  const result = convert(effortOnly);
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.prescription.steps.flatMap((item) => item.kind === 'repeat' ? [item.interval.target, item.recovery.target] : [item.target]),
    [{ type: 'none' }, { type: 'none' }, { type: 'none' }, { type: 'none' }],
  );
});

test('narrative and structure describe the same sequence, durations, repetitions, recoveries and targets', () => {
  const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const targetText = (target) => {
    if (target.type === 'heart_rate')
      return `Target HR: ${target.lower_bpm === target.upper_bpm ? target.lower_bpm : `${target.lower_bpm}–${target.upper_bpm}`} bpm`;
    if (target.type === 'pace')
      return `target pace ${target.faster_seconds === target.slower_seconds ? clock(target.faster_seconds) : `${clock(target.faster_seconds)}–${clock(target.slower_seconds)}`} min/km`;
    return null;
  };
  const labels = { warmup: 'Warm-up', run: 'Main set', repeat: 'Main set', cooldown: 'Cool-down' };
  for (const value of [continuous, intervals, variable, longRun]) {
    const details = weekly.materializePrescription(value, 'en-US').value.details.split('\n');
    const { prescription } = convert(value);
    const phaseLines = details.filter((line) => /^(Warm-up|Main set|Cool-down):/.test(line));
    const recoveryLines = details.filter((line) => line.startsWith('Recovery between repeats:'));
    const effortLines = details.filter((line) => line.startsWith('Effort:'));
    assert.equal(phaseLines.length, prescription.steps.length);
    let recoveries = 0;
    prescription.steps.forEach((item, index) => {
      const block = item.kind === 'repeat' ? item.interval : item;
      const amount = block.end.type === 'time' ? `${block.end.value / 60} min` : `${block.end.value} m`;
      const count = item.kind === 'repeat' ? `${item.repetitions} × ` : '';
      assert.ok(phaseLines[index].startsWith(`${labels[item.kind]}: ${count}${amount}`), phaseLines[index]);
      const expectedTarget = targetText(block.target);
      if (expectedTarget) assert.ok(effortLines[index].endsWith(`; ${expectedTarget}`), effortLines[index]);
      else assert.doesNotMatch(effortLines[index], /Target HR|target pace/);
      if (item.kind === 'repeat') {
        const line = recoveryLines[recoveries++];
        assert.ok(line.startsWith(`Recovery between repeats: ${item.recovery.end.value / 60} min;`), line);
        const recoveryTarget = targetText(item.recovery.target);
        if (recoveryTarget) assert.ok(line.endsWith(`; ${recoveryTarget}`), line);
        // N−1 recoveries in the narrative duration, so the last rest is skipped.
        assert.equal(item.skip_last_rest_step, true);
      }
    });
    assert.equal(recoveries, recoveryLines.length);
  }
  // Duration agrees: the narrative total equals the structure with N−1 recoveries.
  const timed = session([
    step('warmup', { minutes: 10 }),
    step('main', { repetitions: 5, minutes: 3, recoveryMinutes: 2 }),
    step('cooldown', { minutes: 5 }),
  ]);
  const seconds = convert(timed).prescription.steps.reduce((sum, item) =>
    sum + (item.kind === 'repeat'
      ? item.interval.end.value * item.repetitions + item.recovery.end.value * (item.repetitions - 1)
      : item.end.value), 0);
  assert.equal(seconds / 60, weekly.materializePrescription(timed).value.durationMinutes);
});

test('anything the Garmin contract cannot represent is reported, never adapted', () => {
  const codes = (result) => result.issues.map((issue) => issue.code);
  const tooManyReps = convert(session([
    step('warmup', { minutes: 10 }),
    step('main', { repetitions: 21, minutes: 1, recoveryMinutes: 1 }),
    step('cooldown', { minutes: 10 }),
  ]));
  assert.equal(tooManyReps.status, 'incompatible');
  assert.equal(tooManyReps.prescription, null);
  assert.deepEqual(tooManyReps.issues, [{ code: 'repetition_count_invalid', severity: 'blocking', step_index: 1, step_id: 'run-1', field: 'repetitions', actual: 21, maximum: 20 }]);

  const zeroRecovery = convert(session([
    step('warmup', { minutes: 10 }),
    step('main', { repetitions: 4, minutes: 2, recoveryMinutes: 0 }),
    step('cooldown', { minutes: 10 }),
  ]));
  assert.deepEqual(zeroRecovery.issues, [{ code: 'zero_recovery', severity: 'blocking', step_index: 1, step_id: 'run-1', field: 'recovery' }]);
  assert.equal(zeroRecovery.prescription, null);

  const badName = convert(continuous, { name: 'A'.repeat(33) });
  assert.deepEqual(codes(badName), ['name_invalid']);
  assert.equal(convert(continuous, { name: 'Run <script>' }).status, 'incompatible');

  const expanded = convert(session([
    step('warmup', { minutes: 5 }),
    step('main', { repetitions: 20, minutes: 1, recoveryMinutes: 1 }),
    step('main', { repetitions: 20, minutes: 1, recoveryMinutes: 1 }),
    step('cooldown', { minutes: 5 }),
  ]));
  assert.deepEqual(expanded.issues, [{ code: 'expanded_steps_limit', severity: 'blocking', actual: 82, maximum: 50 }]);

  const farther = convert(session([
    step('warmup', { minutes: 5 }),
    step('main', { distanceMeters: 60000, paceSecondsPerKm: 300 }),
    step('main', { distanceMeters: 60000, paceSecondsPerKm: 300 }),
    step('cooldown', { minutes: 5 }),
  ]));
  assert.deepEqual(farther.issues, [{ code: 'distance_limit', severity: 'blocking', field: 'total_distance', actual: 120000, maximum: 100000, unit: 'meters' }]);
  assert.equal(farther.prescription, null);
});

test('v3 sessions convert without parsing free-text HR, widening a single pace or splitting long steps', () => {
  const base = legacy(session([
    step('warmup', { minutes: 10 }),
    step('main', { repetitions: 5, minutes: 3, recoveryMinutes: 2 }),
    step('main', { minutes: 130 }),
    step('cooldown', { minutes: 10 }),
  ]));
  base.prescription[1] = { ...base.prescription[1], targetHr: '160-170 bpm', paceTargetSecondsPerKm: 255 };
  const result = convert(base, { version: weekly.LEGACY_VERSION });
  assert.equal(result.status, 'incompatible');
  assert.deepEqual(result.issues, [
    { code: 'hr_text_unstructured', severity: 'warning', step_index: 1, step_id: 'run-1', field: 'target' },
    { code: 'point_pace_target', severity: 'warning', step_index: 1, step_id: 'run-1', field: 'target' },
    { code: 'step_duration_limit', severity: 'blocking', step_index: 2, step_id: 'run-2', field: 'end', actual: 7800, maximum: 7200, unit: 'seconds' },
  ]);

  base.prescription[2] = { ...base.prescription[2], minutes: 40 };
  const reviewable = convert(base, { version: weekly.LEGACY_VERSION });
  assert.equal(reviewable.status, 'needs_review');
  assert.deepEqual(reviewable.prescription.steps[1].interval.target, { type: 'none' });
  assert.deepEqual(reviewable.prescription.steps[1].recovery.target, { type: 'none' });
  assert.deepEqual(reviewable.issues.map((issue) => issue.severity), ['warning', 'warning']);
  assert.equal(convert(legacy(continuous), { version: weekly.LEGACY_VERSION, name: 'Easy run' }).status, 'ready');
});

test('weekly-workouts-v3 materialization stays byte-identical and is validated only as v3', () => {
  const v3 = legacy(session([
    step('warmup', { minutes: 10, rpe: 2 }),
    step('main', { repetitions: 5, distanceMeters: 800, paceSecondsPerKm: 270, rpe: 4, recoveryRpe: 1, recoveryMinutes: 2 }),
    step('main', { minutes: 130, rpe: 2 }),
    step('cooldown', { minutes: 10, rpe: 2 }),
  ], 'intervals'));
  v3.prescription[1] = { ...v3.prescription[1], targetHr: '160-170 bpm', paceTargetSecondsPerKm: 255 };
  const materialized = weekly.materializePrescription(v3, 'en-US', weekly.LEGACY_VERSION).value;
  // Captured from main (weekly-workouts-v3), including its historical
  // "min/km min/km" pace suffix, so pending proposals keep their signatures.
  assert.equal(
    materialized.details,
    'Warm-up: 10 min\nExecution: Run with relaxed form.\nEffort: Controlled breathing.; RPE 2/5\n'
      + 'Main set: 5 × 800 m (estimated 4 min per repetition, based on the supplied 4:30 min/km pace; this is not a target)\n'
      + 'Execution: Run with relaxed form.\nEffort: Controlled breathing.; RPE 4/5; Target HR: 160-170 bpm; target pace 4:15 min/km min/km\n'
      + 'Recovery between repeats: 2 min; Jog easily.; RPE 1/5\n'
      + 'Main set: 130 min\nExecution: Run with relaxed form.\nEffort: Controlled breathing.; RPE 2/5\n'
      + 'Cool-down: 10 min\nExecution: Run with relaxed form.\nEffort: Controlled breathing.; RPE 2/5\n'
      + 'Estimated duration: 178 min (rounded up using the supplied pace; not a pace target).',
  );
  assert.equal(materialized.prescription, v3.prescription);
  const context = {
    resource: { weekStart: '2026-10-26' },
    availability: [{ day_key: 'monday', can_train: 1, available_periods: '["08_12"]', available_minutes: 240, location: 'Porto, Portugal' }],
    shoes: [],
    sources: [{ type: 'cycle', id: 'cycle' }],
    weather: [],
  };
  const v3Proposal = { schemaVersion: weekly.LEGACY_VERSION, weekStart: '2026-10-26', sessions: [v3] };
  assert.equal(weekly.validateWeeklyProposal(v3Proposal, context, weekly.LEGACY_VERSION), null);
  assert.equal(weekly.validateWeeklyProposal(v3Proposal, context).code, 'shape');
  assert.equal(weekly.validateWeeklyProposal({ ...v3Proposal, schemaVersion: weekly.VERSION }, context).code, 'shape');
  assert.equal(weekly.validateWeeklyProposal(v3Proposal, context, 'weekly-workouts-v2').code, 'shape');
  const badLegacy = structuredClone(v3Proposal);
  badLegacy.sessions[0].prescription[0].targetHr = null;
  assert.equal(weekly.validateWeeklyProposal(badLegacy, context, weekly.LEGACY_VERSION).code, 'shape');
  badLegacy.sessions[0].prescription[0].targetHr = '';
  badLegacy.sessions[0].prescription[0].paceTargetSecondsPerKm = '300';
  assert.equal(weekly.validateWeeklyProposal(badLegacy, context, weekly.LEGACY_VERSION).code, 'shape');
  // The adapter only accepts the current version from the provider.
  const adapter = weekly.createWeeklyWorkoutAdapter(null);
  assert.equal(adapter.version, weekly.VERSION);
  assert.equal(adapter.validate(v3Proposal, context), false);
  assert.equal(adapter.diagnose(v3Proposal, context).code, 'shape');
});

test('a completed weekly-workouts-v3 execution remains readable and applicable after the v4 release', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES(1,'v3@example.invalid','synthetic','user','en-US')").run();
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status) VALUES('cycle',1,'Base','active')").run();
  const row = { day_key: 'monday', can_train: 1, available_periods: '["08_12"]', available_minutes: 240, location: 'Porto, Portugal', updated_at: '2026-10-24' };
  const v3 = legacy(continuous);
  const response = { schemaVersion: weekly.LEGACY_VERSION, weekStart: '2026-10-26', sessions: [v3] };
  const context = {
    resource: { weekStart: '2026-10-26' },
    availability: [row],
    shoes: [],
    sources: [{ type: 'cycle', id: 'cycle' }],
    preferences: { temperature: 'C', language: 'en-US' },
  };
  const insert = (id, adapterVersion) => {
    db.prepare(
      `INSERT INTO ai_executions(id,user_id,idempotency_key,purpose,input_hash,prompt_version,external_prompt,context_json,payload_json,configuration_json,state,reserved_tokens,reserved_cost,created_at,updated_at) VALUES(?,1,?,'workouts','x','v','prompt',?,'{}',?,'completed',1,0,'2026-10-24','2026-10-24')`,
    ).run(id, `key-${id}`, JSON.stringify(context), JSON.stringify({ adapterVersion }));
    db.prepare('INSERT INTO weekly_workout_proposals(execution_id,user_id,week_start,created_at) VALUES(?,1,?,?)').run(id, '2026-10-26', '2026-10-24');
  };
  insert('v3-execution', weekly.LEGACY_VERSION);
  const service = { get: (_user, id) => ({ id, purpose: 'workouts', state: 'completed', outdated: false, response }) };
  const read = weekly.readWeeklyProposal(db, 1, 'v3-execution', service);
  assert.equal(read.proposal.schemaVersion, weekly.LEGACY_VERSION);
  assert.equal(read.proposal.sessions[0].details, weekly.materializePrescription(v3, 'en-US', weekly.LEGACY_VERSION).value.details);
  const applied = weekly.applyWeeklyProposal(db, 1, 'v3-execution', { expected_response_hash: hash(response) }, service);
  assert.equal(applied.added, 1);
  assert.equal(
    db.prepare('SELECT detalhes FROM trainings WHERE id=?').get(applied.addedIds[0]).detalhes,
    read.proposal.sessions[0].details,
  );

  insert('v2-execution', 'weekly-workouts-v2');
  for (const action of [
    () => weekly.readWeeklyProposal(db, 1, 'v2-execution', service),
    () => weekly.applyWeeklyProposal(db, 1, 'v2-execution', { expected_response_hash: hash(response) }, service),
  ])
    assert.throws(action, (error) => error instanceof AiError && error.code === 'weeklySchemaIncompatible');
  db.close();
});

test('weekly-workouts-v3 keeps its legacy target text and validation errors in both languages', () => {
  const base = legacy(session([
    step('warmup', { minutes: 10 }),
    step('main', { repetitions: 3, minutes: 4, recoveryMinutes: 2 }),
    step('cooldown', { minutes: 10 }),
  ], 'intervals'));
  const withMain = (overrides) => ({
    ...base,
    prescription: base.prescription.map((item, index) => (index === 1 ? { ...item, ...overrides } : item)),
  });
  const v3 = (value, language = 'en-US') => weekly.materializePrescription(value, language, weekly.LEGACY_VERSION);
  assert.match(v3(withMain({ targetHr: '150-160 bpm', paceTargetSecondsPerKm: 300 }), 'pt-BR').value.details,
    /Esforço: Controlled breathing\.; FC alvo: 150-160 bpm; ritmo-alvo 5:00 min\/km min\/km\nRecuperação entre repetições: 2 min; Jog easily\.\n/);
  assert.doesNotMatch(v3(base, 'pt-BR').value.details, /FC alvo|ritmo-alvo/);
  assert.equal(v3(withMain({ targetHr: 'easy' })).error, 'unit');
  assert.equal(v3(withMain({ targetHr: '1'.repeat(81) })).error, 'text_length');
  assert.equal(v3(withMain({ paceTargetSecondsPerKm: 119 })).error, 'prescription_pace_target');
  assert.equal(v3(withMain({ paceTargetSecondsPerKm: 1801 })).error, 'prescription_pace_target');
  assert.equal(v3(withMain({ paceTargetSecondsPerKm: 300.5 })).error, 'prescription_pace_target');
  assert.equal(v3(withMain({ targetHr: 'RPE 8/10 140 bpm' })).error, 'incompatible_rpe');
  // A 130-minute v3 component is still valid v3 (the 120-minute cap is v4 only).
  assert.equal(v3(withMain({ repetitions: 1, minutes: 130, recoveryMinutes: null, recoveryGuidance: null })).error, undefined);
});

test('weekly-workouts-v4 writes structured targets in Portuguese, including repeated recoveries', () => {
  const details = weekly.materializePrescription(session([
    step('warmup', { minutes: 10, target: hr(120, 120) }),
    step('main', { repetitions: 3, minutes: 4, target: pace(270, 270), recoveryMinutes: 2, recoveryTarget: pace(360, 400) }),
    step('cooldown', { minutes: 10 }),
  ], 'intervals'), 'pt-BR').value.details;
  assert.match(details, /Esforço: Controlled breathing\.; FC alvo: 120 bpm\n/);
  assert.match(details, /Esforço: Controlled breathing\.; ritmo-alvo 4:30 min\/km\n/);
  assert.match(details, /Recuperação entre repetições: 2 min; Jog easily\.; ritmo-alvo 6:00–6:40 min\/km\n/);
});

test('weekly-workouts-v4 still caps the whole session at 720 minutes across split blocks', () => {
  const blocks = Array.from({ length: 5 }, () => step('main', { minutes: 110 }));
  const value = session([step('warmup', { minutes: 110 }), ...blocks, step('cooldown', { minutes: 110 })], 'long');
  assert.deepEqual(weekly.materializePrescription(value), { error: 'prescription_value' });
});

test('the v4 global heart rate counts repeated recoveries, while v3 keeps its work-only derivation', () => {
  const repeats = (recoveryTarget) => session([
    step('warmup', { minutes: 10, target: hr(140, 150) }),
    step('main', { repetitions: 4, minutes: 3, target: hr(140, 150), recoveryMinutes: 2, recoveryTarget }),
    step('cooldown', { minutes: 10, target: hr(140, 150) }),
  ], 'intervals');
  assert.equal(weekly.materializePrescription(repeats(hr(110, 120))).value.targetHr, '', 'a different recovery target is not uniform');
  assert.equal(weekly.materializePrescription(repeats(NONE)).value.targetHr, '', 'a recovery without HR target is not uniform');
  assert.equal(weekly.materializePrescription(repeats(hr(140, 150))).value.targetHr, '140–150 bpm');
  const v3 = legacy(repeats(NONE));
  v3.prescription = v3.prescription.map((item) => ({ ...item, targetHr: '140-150 bpm' }));
  assert.equal(weekly.materializePrescription(v3, 'en-US', weekly.LEGACY_VERSION).value.targetHr, '140-150 bpm');
});
