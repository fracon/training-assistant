'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { readAiConfig } = require('../src/ai/config');
const { buildContext, POLICY_VERSION } = require('../src/ai/context');
const { dashboardSummary, weekStart } = require('../src/dashboard');
const { buildServer } = require('../src/server');

const today = '2026-11-11'; // Wednesday
const config = readAiConfig({});

function fixture(t) {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES (1,'dash@example.invalid','x'),(2,'other@example.invalid','x')").run();
  const training = (values) => {
    const row = { user_id: 1, tipo: 'Run', treino: null, detalhes: null, completed: 0, feedback_rpe: null, fit_distance: null, tenis: null, ...values };
    return db.prepare(`INSERT INTO trainings(user_id,dia,tipo,treino,detalhes,completed,feedback_rpe,fit_distance,tenis)
      VALUES (@user_id,@dia,@tipo,@treino,@detalhes,@completed,@feedback_rpe,@fit_distance,@tenis)`).run(row).lastInsertRowid;
  };
  return { db, training };
}

function plan(phases) {
  const phase = ([name, start, end]) => ({ name, start, end, objective: `${name} objective`, volume: 'v', longRuns: 'l', quality: 'q', intensity: 'i', easyRuns: 'e', strength: 's', risks: 'r', advanceCriteria: 'c', rationale: 'r', evidence: [] });
  return { schemaVersion: 'cycle-plan-v1', cycleId: 'c', start: phases[0][1], end: phases.at(-1)[2], assessment: 'a', continuity: 'c', feasibility: 'f', confidence: 'moderate',
    phases: phases.map(phase), indicators: ['RPE', 'Volume', 'Long run', 'Pain', 'Recovery'],
    adaptations: { increase: 'x', maintain: 'x', reduce: 'x', replaceQuality: 'x', reduceLongRun: 'x' }, uncertainties: [], assumptions: [], questions: [] };
}
function applyPlan(db, value, fingerprint) {
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO cycle_plan_versions(id,user_id,cycle_id,version,plan_json,context_hash,cycle_hash,fingerprint_json,sources_json,applied_at) VALUES (?,1,'c',?,?,'h','h',?,'[]','2026-10-02T10:00:00.000Z')")
    .run(`p${Date.now()}${Math.random()}`, db.prepare("SELECT COUNT(*) AS n FROM cycle_plan_versions").get().n + 1, JSON.stringify(value), JSON.stringify(fingerprint));
  db.pragma('foreign_keys = ON');
}

test('weeks start on Monday or Sunday by preference', () => {
  assert.equal(weekStart(today, 'Monday'), '2026-11-09');
  assert.equal(weekStart(today, 'Sunday'), '2026-11-08');
  assert.equal(weekStart('2026-11-08', 'Monday'), '2026-11-02');
});

test('an empty account has no next workout and nothing pending', (t) => {
  const { db } = fixture(t);
  const summary = dashboardSummary(db, 1, config, today);
  assert.deepEqual(summary, { today, nextWorkout: null, pending: [] });
  assert.equal(typeof dashboardSummary(db, 1, config).today, 'string', 'today defaults to the account date');
});

test('the next workout carries its plan, shoe and watch-account schedule', (t) => {
  const { db, training } = fixture(t);
  training({ dia: '2026-11-09', treino: 'Intervals', completed: 1, feedback_rpe: 5, fit_distance: 8 });
  const next = training({ dia: today, treino: 'Easy run', detalhes: '40 min easy', tenis: '  Pegasus  ' });
  training({ dia: '2026-11-13', treino: 'Later' });
  training({ user_id: 2, dia: today, treino: 'Foreign' });
  let summary = dashboardSummary(db, 1, config, today);
  assert.equal(summary.nextWorkout.id, next);
  assert.equal(summary.nextWorkout.name, 'Easy run');
  assert.deepEqual(summary.nextWorkout.shoe, { name: 'Pegasus', source: 'planned' });
  assert.equal(summary.nextWorkout.watch, null);
  // Without a planned shoe the least-used active pair is suggested; the name falls back to the type.
  db.prepare("UPDATE trainings SET tenis=NULL, treino=NULL WHERE id=?").run(next);
  db.prepare("INSERT INTO shoes(user_id,brand,model,mileage,target_mileage,status) VALUES (1,'Asics','Novablast',120,800,'active'),(1,'Nike','Pegasus',410,700,'active'),(1,'Old','Retired',5,700,'retired')").run();
  summary = dashboardSummary(db, 1, config, today);
  assert.deepEqual(summary.nextWorkout.shoe, { name: 'Asics Novablast', source: 'least_used' });
  assert.equal(summary.nextWorkout.name, 'Run');
  // Scheduled in the watch account only for the current date and prescription revision.
  db.pragma('foreign_keys = OFF');
  const operation = db.prepare(`INSERT INTO garmin_training_operations(operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date)
    VALUES (?,1,?,?,?,'f',1,?,'done',?)`);
  operation.run('op1', next, 1, 1, 'scheduled', today);
  assert.equal(dashboardSummary(db, 1, config, today).nextWorkout.watch, 'scheduled', 'no saved prescription to compare');
  db.prepare("INSERT INTO garmin_workout_prescriptions(user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,?,2,'{}','f')").run(next);
  assert.equal(dashboardSummary(db, 1, config, today).nextWorkout.watch, null, 'a newer prescription revision is not scheduled yet');
  operation.run('op2', next, 1, 2, 'scheduled', '2026-11-12');
  assert.equal(dashboardSummary(db, 1, config, today).nextWorkout.watch, null, 'a schedule for another date does not count');
  operation.run('op3', next, 1, 2, 'scheduled', today);
  assert.equal(dashboardSummary(db, 1, config, today).nextWorkout.watch, 'scheduled');
  operation.run('op4', next, 2, 2, 'failed', today);
  assert.equal(dashboardSummary(db, 1, config, today).nextWorkout.watch, null);
  db.pragma('foreign_keys = ON');
  db.prepare('DELETE FROM shoes WHERE user_id=1').run();
  assert.equal(dashboardSummary(db, 1, config, today).nextWorkout.shoe, null);
});

test('an outdated or incompatible applied cycle plan is pending; a current or missing one is not', (t) => {
  const { db } = fixture(t);
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,start_date,target_date) VALUES ('c',1,'Half','active','2026-10-01','2026-12-20')").run();
  assert.deepEqual(dashboardSummary(db, 1, config, today).pending, [], 'a cycle without a plan');
  const context = buildContext(db, 1, { purpose: 'cycle', resourceId: 'c', asOf: today, config });
  const fingerprint = { hash: context.hash, asOf: today, purpose: 'cycle', resource: { id: 'c' }, policyVersion: POLICY_VERSION };
  applyPlan(db, plan([['Base', '2026-10-01', '2026-11-01'], ['Build', '2026-11-02', '2026-12-01'], ['Taper', '2026-12-02', '2026-12-20']]), fingerprint);
  assert.deepEqual(dashboardSummary(db, 1, config, today).pending, []);
  db.prepare("UPDATE training_cycles SET objective='Changed' WHERE id='c'").run();
  let summary = dashboardSummary(db, 1, config, today);
  assert.deepEqual(summary.pending, [{ key: 'plan', state: 'outdated', href: '/cycles.html' }]);
  const incompatible = plan([['Base', '2026-12-01', '2026-12-20']]);
  incompatible.phases[0].intensity = 'Hold RPE 8/10.';
  applyPlan(db, incompatible, fingerprint);
  summary = dashboardSummary(db, 1, config, today);
  assert.deepEqual(summary.pending, [{ key: 'plan', state: 'incompatible', href: '/cycles.html' }]);
});

test('pending lists missing results and effort, a ready proposal, hypotheses and a worn shoe, most urgent first', (t) => {
  const { db, training } = fixture(t);
  training({ dia: '2026-10-20' }); // outside the 14-day window
  const missingResult = training({ dia: '2026-11-10' });
  training({ dia: today }); // today is not overdue
  const missingEffort = training({ dia: '2026-11-09', completed: 1, fit_distance: 5 });
  training({ dia: '2026-11-08', completed: 1, feedback_rpe: 3 });
  db.prepare("INSERT INTO shoes(user_id,brand,model,mileage,target_mileage,status) VALUES (1,'Nike','Worn',650,700,'active'),(1,'Asics','Worse',790,800,'active'),(1,'No','Target',900,0,'active')").run();
  const execution = db.prepare(`INSERT INTO ai_executions(id,user_id,idempotency_key,purpose,resource_id,input_hash,prompt_version,external_prompt,context_json,payload_json,configuration_json,state,reserved_tokens,reserved_cost,created_at,updated_at)
    VALUES (?,1,?,'workouts',NULL,'h','v','p','{}','{}','{}',?,1,0,?,?)`);
  const proposal = db.prepare('INSERT INTO weekly_workout_proposals(execution_id,user_id,week_start,created_at,applied_at) VALUES (?,1,?,?,?)');
  execution.run('old', 'k-old', 'completed', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
  proposal.run('old', '2026-11-02', '2026-11-01T00:00:00Z', null);
  let keys = dashboardSummary(db, 1, config, today).pending.map((item) => item.key);
  assert.deepEqual(keys, ['results', 'effort', 'shoe'], 'a proposal for a past week is not pending');
  execution.run('ready', 'k-ready', 'completed', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z');
  proposal.run('ready', '2026-11-16', '2026-11-10T00:00:00Z', null);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO ai_interpretations(id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
    VALUES ('i1',1,?,'a','pattern','t','[]','[]','h','c','pending','x','x'),('i2',1,?,'a','pattern','t','[]','[]','h2','c2','dismissed','x','x')`).run(missingEffort, missingEffort);
  db.pragma('foreign_keys = ON');
  const summary = dashboardSummary(db, 1, config, today);
  assert.deepEqual(summary.pending, [
    { key: 'results', count: 1, href: `/training-result.html?id=${missingResult}` },
    { key: 'effort', count: 1, href: `/training-result.html?id=${missingEffort}` },
    { key: 'proposal', weekStart: '2026-11-16', href: '/ai-coach.html' },
    { key: 'hypotheses', count: 1, href: '/training-memory.html' },
    { key: 'shoe', name: 'Asics Worse', percent: 99, href: '/shoes.html' },
  ]);
  db.prepare("UPDATE weekly_workout_proposals SET applied_at='2026-11-10T01:00:00Z' WHERE execution_id='ready'").run();
  keys = dashboardSummary(db, 1, config, today).pending.map((item) => item.key);
  assert.ok(!keys.includes('proposal'), 'an applied proposal is not pending');
  execution.run('running', 'k-running', 'running', '2026-11-11T00:00:00Z', '2026-11-11T00:00:00Z');
  keys = dashboardSummary(db, 1, config, today).pending.map((item) => item.key);
  assert.ok(!keys.includes('proposal'), 'only the latest weekly execution counts');
});

test('an imported result left open without effort asks for the effort, not for a result', (t) => {
  const { db, training } = fixture(t);
  const imported = training({ dia: '2026-11-10', fit_distance: 7 });
  const today_ = training({ dia: today, fit_distance: 5 });
  db.prepare("UPDATE trainings SET result_data_source='garmin_connect' WHERE id IN (?,?)").run(imported, today_);
  const outOfRange = training({ dia: '2026-11-09', completed: 1 });
  db.prepare('UPDATE trainings SET feedback_rpe=9 WHERE id=?').run(outOfRange);
  assert.deepEqual(dashboardSummary(db, 1, config, today).pending, [
    { key: 'effort', count: 3, href: `/training-result.html?id=${today_}` },
  ]);
});

test('GET /api/dashboard requires a session and reads only the signed-in account', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  t.after(async () => { await app.close(); db.close(); });
  assert.equal((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode, 401);
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'route@example.test', password: 'dash-secret-1', first_name: 'D', last_name: 'R' } });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'other@example.test', password: 'dash-secret-1', first_name: 'O', last_name: 'R' } });
  db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,completed) VALUES (2,'2099-01-01','Run','Foreign',0)").run();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'route@example.test', password: 'dash-secret-1' } });
  const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
  const response = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().nextWorkout, null);
});
