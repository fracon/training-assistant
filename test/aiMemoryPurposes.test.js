'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { readAiConfig } = require('../src/ai/config');
const { memoryOverview, nextMonday } = require('../src/ai/overview');
const { buildContext } = require('../src/ai/context');
const { buildServer } = require('../src/server');

const asOf = '2026-11-11'; // a Wednesday

function fixture(t) {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES (1,'purpose@example.invalid','x'),(2,'other@example.invalid','x')").run();
  const config = readAiConfig({});
  return { db, config };
}

function plan(start, end) {
  const phase = (name, a, b, objective) => ({ name, start: a, end: b, objective, volume: 'v', longRuns: 'l', quality: 'q', intensity: 'i', easyRuns: 'e', strength: 's', risks: 'r', advanceCriteria: 'c', rationale: 'r', evidence: [] });
  return {
    schemaVersion: 'cycle-plan-v1', cycleId: 'c', start, end, assessment: 'a', continuity: 'c', feasibility: 'f', confidence: 'moderate',
    phases: [phase('Base', start, '2026-11-01', 'Aerobic volume'), phase('Build', '2026-11-02', '2026-12-01', 'Race pace'), phase('Taper', '2026-12-02', end, 'Arrive rested')],
    indicators: ['Recorded RPE', 'Weekly volume', 'Long run', 'Discomfort', 'Recovery'], adaptations: { increase: 'x', maintain: 'x', reduce: 'x', replaceQuality: 'x', reduceLongRun: 'x' },
    uncertainties: [], assumptions: [], questions: [],
  };
}

test('next Monday is always the following week, also from a Monday or a Sunday', () => {
  assert.equal(nextMonday('2026-11-11'), '2026-11-16');
  assert.equal(nextMonday('2026-11-16'), '2026-11-23');
  assert.equal(nextMonday('2026-11-15'), '2026-11-16');
});

test('each purpose projects the selection of its own task, with plan, shoes, previous cycles and priorities', (t) => {
  const { db, config } = fixture(t);
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,start_date,target_date) VALUES ('c',1,'Half marathon','active','2026-10-01','2026-12-20'),('old',1,'First 10 km','completed','2026-06-01','2026-08-01'),('foreign',2,'Private','completed',NULL,NULL)").run();
  db.prepare("INSERT INTO shoes(user_id,brand,model,mileage,target_mileage,status) VALUES (1,'Nike','Pegasus',410,700,'active'),(2,'Private','Shoe',1,1,'active')").run();
  const insert = db.prepare('INSERT INTO trainings(id,user_id,dia,tipo,treino,completed,feedback_rpe,feedback_has_pain,feedback_pain,fit_distance,fit_duration) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  insert.run(1, 1, '2026-11-09', 'Run', 'Intervals', 1, 5, 'no', null, 8, '45:00');
  insert.run(2, 1, '2026-11-07', 'Run', 'Easy', 1, 2, 'yes', 'Shin', 6, '35:00');
  insert.run(3, 1, '2026-11-05', 'Run', 'Easy', 1, 2, 'no', null, 6, '35:00');
  insert.run(4, 1, '2026-11-14', 'Run', 'Long', 0, null, null, null, null, null);
  insert.run(5, 2, '2026-11-09', 'Run', 'Private', 1, 3, null, null, 5, '30:00');
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO cycle_plan_versions(id,user_id,cycle_id,version,plan_json,context_hash,cycle_hash,fingerprint_json,sources_json,applied_at) VALUES ('p',1,'c',1,?,'h','h','{}','[]','2026-10-02T10:00:00.000Z')").run(JSON.stringify(plan('2026-10-01', '2026-12-20')));
  db.pragma('foreign_keys = ON');

  const cycle = memoryOverview(db, 1, config, asOf, { purpose: 'cycle' });
  assert.equal(cycle.purpose, 'cycle');
  assert.deepEqual(cycle.task, { cycleId: 'c' });
  assert.equal(cycle.appliedPlan, null, 'cycle planning never feeds the applied plan back into itself');
  assert.deepEqual(cycle.previousCycles, [{ objective: 'First 10 km', status: 'completed', targetDate: '2026-08-01', startDate: '2026-06-01' }]);
  assert.deepEqual(cycle.shoes, [{ brand: 'Nike', model: 'Pegasus', status: 'active', mileage: 410, targetMileage: 700, href: '/shoes.html' }]);
  assert.deepEqual(cycle.recent.map((r) => [r.date, r.priority]), [['2026-11-09', 'high_effort'], ['2026-11-07', 'concern'], ['2026-11-05', null]]);
  assert.equal(JSON.stringify(cycle).includes('Private'), false);

  const workouts = memoryOverview(db, 1, config, asOf, { purpose: 'workouts' });
  assert.deepEqual(workouts.task, { weekStart: '2026-11-16' });
  assert.equal(workouts.previousCycles.length, 0);
  assert.equal(workouts.appliedPlan.version, 1);
  assert.equal(workouts.appliedPlan.appliedAt, '2026-10-02T10:00:00.000Z');
  assert.equal(workouts.appliedPlan.compatibilityError, null);
  assert.deepEqual(workouts.appliedPlan.currentPhase, { name: 'Build', start: '2026-11-02', end: '2026-12-01', objective: 'Race pace' });
  assert.deepEqual(workouts.appliedPlan.architecture.map((p) => p.name), ['Base', 'Build', 'Taper']);
  assert.deepEqual(workouts.appliedPlan.indicators, ['Recorded RPE', 'Weekly volume', 'Long run', 'Discomfort', 'Recovery']);
  // The view equals the selection the weekly task builds for the same week.
  const context = buildContext(db, 1, { purpose: 'workouts', asOf, config, taskDate: '2026-11-16' });
  assert.deepEqual(workouts.recent.map((r) => r.href), context.recent.map((r) => `/training-result.html?id=${r.source.id}`));
  assert.deepEqual(workouts.upcoming.map((r) => r.date), context.upcoming.map((r) => r.date));

  const analysis = memoryOverview(db, 1, config, asOf, { purpose: 'analysis' });
  assert.equal(analysis.task.session.href, '/training-result.html?id=1', 'defaults to the latest completed session');
  assert.equal(analysis.task.session.priority, 'high_effort');
  assert.ok(analysis.recent.every((r) => r.href !== '/training-result.html?id=1'), 'the analyzed session is the task, not a recent entry');
  const chosen = memoryOverview(db, 1, config, asOf, { purpose: 'analysis', resourceId: 3 });
  assert.equal(chosen.task.session.date, '2026-11-05');
  assert.throws(() => memoryOverview(db, 1, config, asOf, { purpose: 'analysis', resourceId: 5 }), (e) => e.code === 'resourceNotFound' && e.status === 404);
  assert.throws(() => memoryOverview(db, 1, config, asOf, { purpose: 'other' }), (e) => e.code === 'invalidPurpose');
});

test('views without a task resource stay readable and state what is missing', (t) => {
  const { db, config } = fixture(t);
  const cycle = memoryOverview(db, 1, config, asOf);
  assert.deepEqual(cycle.task, { cycleId: null });
  const analysis = memoryOverview(db, 1, config, asOf, { purpose: 'analysis' });
  assert.deepEqual(analysis.task, { session: null });
  assert.equal(analysis.appliedPlan, null);
  assert.equal(typeof memoryOverview(db, 1, config).asOf, 'string', 'today defaults to the account date');
});

test('an incompatible applied plan is shown as excluded, and interpretation inclusion is explained', (t) => {
  const { db, config } = fixture(t);
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,start_date,target_date) VALUES ('c',1,'Half marathon','active','2026-10-01','2026-12-20')").run();
  const bad = plan('2026-10-01', '2026-12-20');
  bad.phases[0].intensity = 'Hold RPE 8/10 on every repeat.';
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO cycle_plan_versions(id,user_id,cycle_id,version,plan_json,context_hash,cycle_hash,fingerprint_json,sources_json,applied_at) VALUES ('p',1,'c',1,?,'h','h','{}','[]','2026-10-02T10:00:00.000Z')").run(JSON.stringify(bad));
  db.pragma('foreign_keys = ON');
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino,completed,feedback_rpe,fit_distance,fit_duration) VALUES (1,1,'2026-11-09','Run','Easy',1,3,6,'35:00')").run();
  db.prepare(`INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
    VALUES ('analysis',1,1,1,'workout-analysis-v1','{}','completed','en-US','2026-11-09T10:00:00.000Z')`).run();
  const source = buildContext(db, 1, { purpose: 'workouts', asOf, config, taskDate: '2026-11-16' }).sources.find((ref) => ref.type === 'training');
  const insert = db.prepare(`INSERT INTO ai_interpretations(id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
    VALUES (?,1,1,'analysis','pattern',?,?,?,?,?,?,?,?)`);
  const evidence = JSON.stringify([{ type: 'training', id: '1', version: source.version }]);
  const stale = JSON.stringify([{ type: 'training', id: '1', version: 'stale' }]);
  insert.run('used', 'Used', evidence, 'k1', 'h1', 'c1', 'pending', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
  insert.run('stale', 'Stale', stale, 'k2', 'h2', 'c2', 'confirmed', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
  insert.run('dismissed', 'Dismissed', evidence, 'k3', 'h3', 'c3', 'dismissed', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
  insert.run('superseded', 'Superseded', evidence, 'k4', 'h4', 'c4', 'superseded', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
  const view = memoryOverview(db, 1, config, asOf, { purpose: 'workouts' });
  assert.equal(view.appliedPlan.compatibilityError, 'planningRpeIncompatible');
  assert.equal(view.appliedPlan.currentPhase, null);
  assert.equal(view.omissions.incompatiblePlan, true);
  assert.deepEqual(Object.fromEntries(view.interpretations.map((item) => [item.id, item.inclusion])),
    { used: 'used', stale: 'not_current', dismissed: 'dismissed', superseded: 'superseded' });
});

test('omissions are counted by kind, including budget cuts, reduced details and history', (t) => {
  const { db, config } = fixture(t);
  config.limits.AI_CONTEXT_TOKENS = 2500;
  const insert = db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,detalhes,completed,feedback_rpe,fit_distance,fit_duration) VALUES (1,?,'Run','Session',?,1,2,5,'30:00')");
  for (let i = 0; i < 40; i++) insert.run(`2026-11-${String(1 + (i % 10)).padStart(2, '0')}`, 'x'.repeat(300));
  insert.run('2026-01-05', 'old');
  const view = memoryOverview(db, 1, config, asOf, { purpose: 'cycle' });
  assert.ok(view.omissions.budget.recent > 0);
  assert.equal(view.omissions.budgetTotal, Object.values(view.omissions.budget).reduce((a, b) => a + b, 0));
  assert.ok(view.omissions.reducedDetails > 0);
  assert.equal(view.omissions.historical, 1);
  assert.equal(view.recent.length + view.omissions.budget.recent, 40, 'every recent session is either shown or counted');
});

test('GET /api/ai/memory validates the purpose and only accepts an owned session for analysis', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  t.after(async () => { await app.close(); db.close(); });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'route@example.test', password: 'route-secret-1', first_name: 'R', last_name: 'T' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'route@example.test', password: 'route-secret-1' } });
  const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
  const get = (query) => app.inject({ method: 'GET', url: `/api/ai/memory${query}`, headers: { cookie } });
  assert.equal((await get('')).json().purpose, 'cycle');
  assert.equal((await get('?purpose=workouts')).json().purpose, 'workouts');
  for (const query of ['?purpose=other', '?purpose=cycle&resource_id=1', '?purpose=analysis&resource_id=abc', '?purpose=analysis&resource_id=0', '?extra=1'])
    assert.equal((await get(query)).statusCode, 400, query);
  assert.equal((await get('?purpose=analysis&resource_id=999')).statusCode, 404);
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino,completed,feedback_rpe,fit_distance,fit_duration) VALUES (7,1,'2026-11-01','Run','Mine',1,3,5,'30:00')").run();
  const mine = await get('?purpose=analysis&resource_id=7');
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().task.session.href, '/training-result.html?id=7');
});
