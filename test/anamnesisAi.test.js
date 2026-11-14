'use strict';

// Athlete anamnesis in AI planning (issue #80, PR 2): the consent-aware
// projection, the context source and its freshness without mass invalidation,
// the payload rules, and the requirement for cycle and weekly generation.
// Synthetic data and mocked providers only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const { readAiConfig } = require('../src/ai/config');
const { buildContext, contextIsCurrent, appliedPlanIsCurrent, projectContextForModel } = require('../src/ai/context');
const { buildPayload, SAFETY_INSTRUCTIONS, ANAMNESIS_INSTRUCTIONS } = require('../src/ai/client');
const { createExecutionService } = require('../src/ai/executions');
const { createCyclePlanAdapter } = require('../src/ai/cycle-plan-adapter');
const { createWorkoutAnalysisAdapter } = require('../src/ai/workout-analysis-adapter');
const { readCyclePlanning } = require('../src/ai/cycle-plans');
const { memoryOverview } = require('../src/ai/overview');
const {
  addWeight,
  anamnesisCompleted,
  anamnesisContext,
  anamnesisStatus,
  completeAnamnesis,
  deleteAnamnesis,
  readAnamnesis,
  saveAnamnesis,
} = require('../src/anamnesis');

const YEAR = new Date().getUTCFullYear();
const config = readAiConfig({ AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-test-key' });

const ANSWERS = {
  birth_year: { status: 'answered', value: YEAR - 40 },
  height_cm: { status: 'answered', value: 175 },
  weight: { status: 'answered' },
  motivations: { status: 'answered', value: { options: ['weight_loss', 'other'], other_text: 'Synthetic reason' } },
  running_experience: { status: 'answered', value: 'two_to_5_years' },
  recent_consistency: { status: 'answered', value: 'regular' },
  runs_per_week: { status: 'answered', value: 3 },
  weekly_distance_km: { status: 'answered', value: 25 },
  longest_run_km: { status: 'unknown' },
  race_results: { status: 'answered', value: [{ distance: '21k', time_seconds: 7200, year: YEAR - 1 }, { distance: 'other', distance_km: 15, time_seconds: 5400, year: YEAR - 1 }] },
  strength_training: { status: 'answered', value: 'weekly_1' },
  other_activities: { status: 'answered', value: { answer: 'yes', details: 'Synthetic swimming' } },
  hr_device: { status: 'unknown' },
  current_pain: { status: 'answered', value: { answer: 'yes', details: 'Synthetic knee discomfort' } },
  injuries_12_months: { status: 'answered', value: { answer: 'no' } },
  professional_restriction: { status: 'declined' },
  health_conditions: { status: 'unknown' },
};

function setup() {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash,role) VALUES (1,'athlete@example.invalid','synthetic','admin'),(2,'other@example.invalid','synthetic','user')").run();
  const today = new Date().toISOString().slice(0, 10);
  const target = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,start_date,target_date) VALUES ('cycle',1,'Synthetic goal','active',?,?),('other',2,'Other goal','active',?,?)").run(today, target, today, target);
  return db;
}

function save(db, answers, extra = {}) {
  const revision = readAnamnesis(db, 1).anamnesis.revision;
  return saveAnamnesis(db, 1, { answers, expected_revision: revision, ...extra });
}

function completeWith(db, answers = ANSWERS, extra = {}) {
  addWeight(db, 1, { measured_on: '2026-01-01', weight_kg: 80 });
  addWeight(db, 1, { measured_on: '2026-02-10', weight_kg: 78.5 });
  save(db, answers, extra);
  completeAnamnesis(db, 1, { expected_revision: readAnamnesis(db, 1).anamnesis.revision });
}

const cycleContext = (db, options = {}) => buildContext(db, 1, { purpose: 'cycle', resourceId: 'cycle', config, ...options });

test('only a completed anamnesis is projected, minimally and without sensitive data unless consented', () => {
  const db = setup();
  assert.equal(anamnesisContext(db, 1), null);
  assert.deepEqual(anamnesisStatus(db, 1), { status: 'not_started' });
  save(db, { birth_year: ANSWERS.birth_year });
  assert.equal(anamnesisContext(db, 1), null, 'a draft is never used');
  assert.equal(anamnesisCompleted(db, 1), false);
  completeWith(db);
  assert.equal(anamnesisCompleted(db, 1), true);
  const { projection } = anamnesisContext(db, 1);
  assert.equal(projection.authority, 'user_report');
  assert.equal(projection.sensitiveDataShared, false);
  assert.deepEqual(projection.about, { birthYear: YEAR - 40, motivations: { options: ['weight_loss', 'other'], otherText: 'Synthetic reason' } });
  assert.deepEqual(projection.experience.selfReportedBase, {
    note: 'Self-reported by the athlete when answering. Measured sessions in this context take precedence.',
    runsPerWeek: 3, weeklyDistanceKm: 25, longestRunKm: 'not_informed',
  });
  assert.deepEqual(projection.experience.raceResults, [
    { distance: '21k', distanceKm: 21.0975, timeSeconds: 7200, year: YEAR - 1 },
    { distance: 'other', distanceKm: 15, timeSeconds: 5400, year: YEAR - 1 },
  ]);
  assert.deepEqual(projection.routine, { strengthTraining: 'weekly_1', otherActivities: { answer: 'yes', details: 'Synthetic swimming' }, heartRateDevice: 'not_informed' });
  // Without consent nothing sensitive is present, not even as "not informed".
  assert.equal(Object.hasOwn(projection, 'body'), false);
  assert.equal(Object.hasOwn(projection, 'health'), false);
  assert.doesNotMatch(JSON.stringify(projection), /175|78\.5|knee|Synthetic knee/);

  save(db, {}, { sensitive_ai_consent: true });
  const shared = anamnesisContext(db, 1).projection;
  assert.equal(shared.sensitiveDataShared, true);
  assert.deepEqual(shared.body, { heightCm: 175, weight: { latestKg: 78.5, measuredOn: '2026-02-10', changeSince: { kg: 80, measuredOn: '2026-01-01' } } });
  assert.deepEqual(shared.health, {
    currentPain: { answer: 'yes', details: 'Synthetic knee discomfort' },
    injuriesLast12Months: { answer: 'no' },
    professionalRestriction: 'not_informed',
    healthConditions: 'not_informed',
  });
  // The change covers the trend window only; one entry has no change.
  addWeight(db, 1, { measured_on: '2026-06-01', weight_kg: 77 });
  assert.deepEqual(anamnesisContext(db, 1).projection.body.weight, { latestKg: 77, measuredOn: '2026-06-01' });
  // Defensive: an answered weight without entries (only possible by editing
  // the database directly) is "not informed" rather than a failure.
  const kept = db.prepare('SELECT * FROM body_weight_entries').all();
  db.prepare('DELETE FROM body_weight_entries').run();
  assert.equal(anamnesisContext(db, 1).projection.body.weight, 'not_informed');
  for (const row of kept) db.prepare('INSERT INTO body_weight_entries (id,user_id,measured_on,weight_kg,created_at,updated_at) VALUES (@id,@user_id,@measured_on,@weight_kg,@created_at,@updated_at)').run(row);
  // A declined weight stays "not informed" even with consent.
  save(db, { weight: { status: 'declined' } });
  assert.equal(anamnesisContext(db, 1).projection.body.weight, 'not_informed');
  // Zero runs a week make the volume follow-ups not applicable.
  save(db, { runs_per_week: { status: 'answered', value: 0 } });
  assert.deepEqual(anamnesisContext(db, 1).projection.experience.selfReportedBase, {
    note: 'Self-reported by the athlete when answering. Measured sessions in this context take precedence.',
    runsPerWeek: 0, weeklyDistanceKm: 'not_applicable', longestRunKm: 'not_applicable',
  });
  assert.equal(anamnesisContext(db, 2), null, 'another account has none');
  db.close();
});

test('the basis version follows answers and consent, never the weight log', () => {
  const db = setup();
  completeWith(db, ANSWERS, { sensitive_ai_consent: true });
  const first = anamnesisContext(db, 1).basisVersion;
  addWeight(db, 1, { measured_on: '2026-02-20', weight_kg: 78 });
  assert.equal(anamnesisContext(db, 1).basisVersion, first);
  save(db, {}, { sensitive_ai_consent: false });
  assert.notEqual(anamnesisContext(db, 1).basisVersion, first);
  db.close();
});

test('contexts carry the completed anamnesis while older snapshots stay current', () => {
  const db = setup();
  const before = cycleContext(db);
  assert.equal(Object.hasOwn(before, 'anamnesis'), false);
  assert.equal(before.sources.some((ref) => ref.type === 'anamnesis'), false);
  completeWith(db);
  // No mass invalidation: a snapshot built before the source existed is unchanged.
  assert.equal(contextIsCurrent(db, 1, before, config), true);
  const after = cycleContext(db);
  assert.deepEqual(after.anamnesis, anamnesisContext(db, 1).projection);
  const current = anamnesisContext(db, 1);
  assert.deepEqual(after.sources.find((ref) => ref.type === 'anamnesis'), { type: 'anamnesis', id: 'self', version: current.version, basis: current.basisVersion });
  assert.equal(projectContextForModel(after).anamnesis.about.birthYear, YEAR - 40);
  assert.deepEqual(projectContextForModel(after).sources.find((ref) => ref.type === 'anamnesis'), { type: 'anamnesis', id: 'self' }, 'the model never sees versions');
  assert.equal(Object.hasOwn(cycleContext(db, { includeAnamnesis: false }), 'anamnesis'), false);
  assert.equal(contextIsCurrent(db, 1, after, config), true);
  for (const purpose of ['workouts', 'analysis']) assert.ok(buildContext(db, 1, { purpose, config }).anamnesis, purpose);
  // A relevant change outdates only the snapshot that recorded the source.
  save(db, { strength_training: { status: 'answered', value: 'none' } });
  assert.equal(contextIsCurrent(db, 1, after, config), false);
  assert.equal(contextIsCurrent(db, 1, before, config), true);
  const edited = cycleContext(db);
  deleteAnamnesis(db, 1);
  assert.equal(contextIsCurrent(db, 1, edited, config), false, 'erasing the anamnesis outdates what used it');
  db.close();
});

test('an interpretation citing the anamnesis stops being current when its weight evidence changes', () => {
  const db = setup();
  completeWith(db, ANSWERS, { sensitive_ai_consent: true });
  db.prepare("UPDATE body_weight_entries SET weight_kg = 80 WHERE measured_on = '2026-02-10'").run();
  const training = db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,completed,feedback_rpe) VALUES (1,'2026-01-05','Run','Synthetic run',1,3)").run().lastInsertRowid;
  db.prepare(`INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
    VALUES ('synthetic-analysis',1,?,1,'workout-analysis-v1','{}','completed','en-US','2026-03-01T10:00:00.000Z')`).run(training);
  const cited = buildContext(db, 1, { purpose: 'workouts', config }).sources.find((ref) => ref.type === 'anamnesis');
  db.prepare(`INSERT INTO ai_interpretations
    (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
    VALUES ('synthetic-interpretation',1,?,'synthetic-analysis','pattern','Synthetic weight-based hypothesis.',?,'key','hash','content','pending','2026-03-01T10:00:00.000Z','2026-03-01T10:00:00.000Z')`)
    .run(training, JSON.stringify([{ type: 'anamnesis', id: 'self', version: cited.version }]));
  const selected = () => (buildContext(db, 1, { purpose: 'workouts', config }).interpretations || []).map((item) => item.source.id);
  assert.deepEqual(selected(), ['synthetic-interpretation']);
  const basis = anamnesisContext(db, 1).basisVersion;
  // Correcting the weight from 80 kg to 70 kg changes the evidence the
  // interpretation relied on, while the applied-plan basis stays the same.
  db.prepare("UPDATE body_weight_entries SET weight_kg = 70 WHERE measured_on = '2026-02-10'").run();
  assert.equal(anamnesisContext(db, 1).basisVersion, basis);
  assert.deepEqual(selected(), [], 'the stale weight-based interpretation is excluded');
  db.close();
});

test('an applied plan depends on the anamnesis only when it recorded it, and never on the weight log', () => {
  const db = setup();
  const legacy = JSON.stringify(cycleContext(db).sources);
  completeWith(db);
  const recorded = JSON.stringify(cycleContext(db).sources);
  assert.equal(appliedPlanIsCurrent(db, 1, 'cycle', legacy), true, 'older plans are not outdated in bulk');
  assert.equal(appliedPlanIsCurrent(db, 1, 'cycle', recorded), true);
  addWeight(db, 1, { measured_on: '2026-02-20', weight_kg: 78 });
  assert.equal(appliedPlanIsCurrent(db, 1, 'cycle', recorded), true, 'a weigh-in never outdates the plan');
  save(db, { strength_training: { status: 'answered', value: 'none' } });
  assert.equal(appliedPlanIsCurrent(db, 1, 'cycle', recorded), false);
  assert.equal(appliedPlanIsCurrent(db, 1, 'cycle', legacy), true);
  const edited = JSON.stringify(cycleContext(db).sources);
  deleteAnamnesis(db, 1);
  assert.equal(appliedPlanIsCurrent(db, 1, 'cycle', edited), false);
  assert.equal(appliedPlanIsCurrent(db, 1, 'cycle', legacy), true);
  db.close();
});

test('the anamnesis rules reach the model only with an anamnesis in the context', () => {
  const db = setup();
  const adapter = { instructions: 'Synthetic adapter instructions', adaptPrompt: (prompt) => prompt, format: { type: 'json_object' } };
  const payload = (context) => buildPayload({ model: 'synthetic', context, prompt: 'Synthetic prompt', adapter, maxOutputTokens: 100 });
  const without = payload(cycleContext(db));
  assert.equal(without.instructions, `${SAFETY_INSTRUCTIONS}\n${adapter.instructions}`, 'payloads without it are unchanged');
  completeWith(db);
  const withIt = payload(cycleContext(db));
  assert.equal(withIt.instructions, `${SAFETY_INSTRUCTIONS}\n${ANAMNESIS_INSTRUCTIONS}\n${adapter.instructions}`);
  for (const rule of [/nutrition, diet, calorie or supplement advice/, /weight, shape or BMI/, /promise or target weight loss/, /not diagnoses/, /health professional/])
    assert.match(ANAMNESIS_INSTRUCTIONS, rule);
  assert.match(withIt.input[0].content[0].text, /"anamnesis":/);
  db.close();
});

test('cycle and weekly generation require the completed anamnesis; analysis and the free preview do not', async () => {
  const db = setup();
  const calls = [];
  const service = createExecutionService({
    db,
    config,
    operations: { cycle: createCyclePlanAdapter(db), analysis: createWorkoutAnalysisAdapter(db) },
    client: async () => { calls.push(1); return { value: null, usage: null, error: 'synthetic' }; },
  });
  const refuse = (body) => assert.throws(() => service.enqueue(1, body), (error) => error.code === 'anamnesisRequired' && error.status === 409);
  refuse({ purpose: 'cycle', resource_id: 'cycle', idempotency_key: 'synthetic-cycle-1' });
  refuse({ purpose: 'workouts', target_date: '2026-12-07', idempotency_key: 'synthetic-week-1' });
  save(db, { birth_year: ANSWERS.birth_year });
  refuse({ purpose: 'cycle', resource_id: 'cycle', idempotency_key: 'synthetic-cycle-2' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_executions').get().n, 0, 'a refusal creates nothing');
  // Workout analysis and the administrator's free preview are not gated.
  const training = db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,completed,feedback_rpe,fit_distance,fit_duration) VALUES (1,'2026-01-05','Run','Synthetic run',1,3,5,'30:00')").run().lastInsertRowid;
  const analysis = service.enqueue(1, { purpose: 'analysis', resource_id: String(training), idempotency_key: 'synthetic-analysis' });
  assert.equal(analysis.purpose, 'analysis');
  // Let it settle (the synthetic provider fails it) so the per-account limit is free.
  for (let i = 0; i < 400 && ['queued', 'running'].includes(service.get(1, analysis.id).state); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(service.preview(1, { purpose: 'cycle', resource_id: 'cycle' }));
  completeWith(db);
  assert.equal(service.enqueue(1, { purpose: 'cycle', resource_id: 'cycle', idempotency_key: 'synthetic-cycle-3' }).purpose, 'cycle');
  // The planning read tells the modal before any click.
  assert.equal(readCyclePlanning(db, 1, 'cycle', service, config).anamnesisRequired, false);
  assert.equal(readCyclePlanning(db, 2, 'other', service, config).anamnesisRequired, true);
  await service.stop();
  db.close();
});

test('Training memory shows the anamnesis as a source of the task context', () => {
  const db = setup();
  assert.deepEqual(memoryOverview(db, 1, config, '2026-03-01').anamnesis, {
    status: 'not_started', used: false, completedOn: null, updatedOn: null, sensitiveDataShared: false, href: '/anamnesis.html',
  });
  completeWith(db, ANSWERS, { sensitive_ai_consent: true });
  const { anamnesis } = memoryOverview(db, 1, config, '2026-03-01', { purpose: 'workouts' });
  assert.equal(anamnesis.status, 'completed');
  assert.equal(anamnesis.used, true);
  assert.equal(anamnesis.sensitiveDataShared, true);
  assert.match(anamnesis.completedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(anamnesis.updatedOn, anamnesis.completedOn);
  db.close();
});

test('HTTP: the status is owner-scoped and weekly generation is refused before any weather lookup', async (t) => {
  const db = setup();
  let weatherCalls = 0;
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    aiConfig: config,
    weatherFetch: async () => { weatherCalls++; throw new Error('no weather expected'); },
    aiClient: async () => { throw new Error('no provider call expected'); },
  });
  t.after(async () => { await app.close(); db.close(); });
  const cookie = (id) => `${SESSION_COOKIE_NAME}=${createSession(db, id).token}`;
  const call = (id, method, url, payload) => app.inject({ method, url, payload, headers: id ? { cookie: cookie(id) } : {} });
  assert.equal((await call(null, 'GET', '/api/anamnesis/status')).statusCode, 401);
  const status = await call(1, 'GET', '/api/anamnesis/status');
  assert.deepEqual(status.json(), { status: 'not_started' });
  assert.equal(status.headers['cache-control'], 'no-store');
  completeWith(db);
  assert.deepEqual((await call(1, 'GET', '/api/anamnesis/status')).json(), { status: 'completed' });
  assert.deepEqual((await call(2, 'GET', '/api/anamnesis/status')).json(), { status: 'not_started' });
  const weekly = await call(2, 'POST', '/api/ai/executions', { purpose: 'workouts', target_date: '2026-12-07', idempotency_key: 'synthetic-week-http' });
  assert.equal(weekly.statusCode, 409);
  assert.deepEqual(weekly.json(), { error: 'anamnesisRequired', errors: ['anamnesisRequired'] });
  assert.equal(weatherCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_executions').get().n, 0);
});
