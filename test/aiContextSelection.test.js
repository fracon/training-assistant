'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { readAiConfig } = require('../src/ai/config');
const { buildContext, contextIsCurrent, tokenBound } = require('../src/ai/context');
const { hash } = require('../src/ai/memory');

function fixture(t) {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES (1,'selection@example.invalid','synthetic')").run();
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status) VALUES ('cycle',1,'Synthetic target','active')").run();
  const config = readAiConfig({});
  const session = (id, day, details, pain = null, description = null, rpe = null) =>
    db.prepare(`INSERT INTO trainings(id,user_id,dia,tipo,treino,detalhes,completed,
      feedback_has_pain,feedback_pain,feedback_rpe,fit_distance,fit_duration)
      VALUES (?,1,?,'Corrida',?, ?,1,?,?,?,5,'30:00')`)
      .run(id, day, `Synthetic session ${id}`, details, pain, description, rpe);
  const args = { purpose: 'workouts', asOf: '2026-10-14', config };
  return { db, config, session, args };
}

test('recent discomfort and RPE survive the default budget under seven verbose upcoming sessions', (t) => {
  const { db, config, session, args } = fixture(t);
  session(1, '2026-10-13', '', 'yes', 'Synthetic dated discomfort', 5);
  for (let id = 2; id <= 8; id++) session(id, `2026-10-${13 + id}`, 'x'.repeat(340));
  const context = buildContext(db, 1, args);
  assert.equal(context.recent.length, 1, `upcoming=${context.upcoming.length}, recent=${context.recent.length}`);
  assert.equal(context.recent[0].report.feedback_pain, 'Synthetic dated discomfort');
  assert.equal(context.recent[0].report.feedback_rpe, 5);
  assert.equal(context.recent[0].date, '2026-10-13');
  assert.ok(tokenBound(context) <= config.limits.AI_CONTEXT_TOKENS);
  assert.ok(context.omissions.length);
});

for (const purpose of ['cycle', 'workouts', 'analysis']) {
  test(`${purpose} protects recent reports, required sources and configured workout availability before future prose`, (t) => {
    const { db, config, session, args } = fixture(t);
    session(1, '2026-10-12', '', 'yes', 'Synthetic reported discomfort', 5);
    session(2, '2026-10-13', 'x'.repeat(18000), 'no', null, 4);
    for (let id = 3; id <= 9; id++) session(id, `2026-10-${12 + id}`, 'x'.repeat(5000));
    const days = require('../src/availability').DAY_KEYS;
    for (const day of days) db.prepare(`INSERT INTO ai_coach_availability
      (user_id,day_key,can_train,available_periods,available_minutes,location)
      VALUES (1,?,1,'["before_08"]',60,'Synthetic locality')`).run(day);
    const options = { ...args, purpose, resourceId: purpose === 'analysis' ? 1 : purpose === 'cycle' ? 'cycle' : null };
    const context = buildContext(db, 1, options);
    const detailed = [...context.recent, ...context.upcoming, ...context.comparables];
    if (purpose === 'analysis') detailed.push(context.resource);
    assert.equal(detailed.filter((r) => r.source.id === '1').length, 1);
    assert.equal(detailed.find((r) => r.source.id === '1').report.feedback_pain, 'Synthetic reported discomfort');
    assert.equal(context.recent.find((r) => r.source.id === '2').report.feedback_rpe, 4);
    assert.equal(context.recent.find((r) => r.source.id === '2').report.feedback_has_pain, 'no');
    assert.equal(context.recent.find((r) => r.source.id === '2').planned.detalhes, undefined);
    assert.equal(context.cycle.id, 'cycle');
    assert.ok(context.sources.some((r) => r.type === 'cycle' && r.id === 'cycle'));
    if (purpose === 'workouts') assert.equal(context.availability.length, 7);
    if (purpose === 'analysis') assert.equal(context.resource.source.id, '1');
    if (purpose === 'cycle') assert.equal(context.resource.id, 'cycle');
    assert.ok(context.omissions.length);
    assert.ok(tokenBound(context) <= config.limits.AI_CONTEXT_TOKENS);
    assert.equal(new Set(context.sources.map((r) => `${r.type}:${r.id}`)).size, context.sources.length);
    assert.deepEqual(buildContext(db, 1, options), context);
  });
}

test('an oversubscribed recent list retains concern/effort reports before newer low-priority planning details', (t) => {
  const { session, db, args, config } = fixture(t);
  session(1, '2026-10-01', 'x'.repeat(9000), 'yes', 'Whole dated report', 2);
  session(2, '2026-10-02', 'x'.repeat(9000), 'no', null, 5);
  session(3, '2026-10-03', 'x'.repeat(9000), null, null, 4);
  for (let id = 4; id <= 20; id++) session(id, '2026-10-13', 'x'.repeat(9000), 'no', null, 2);
  const context = buildContext(db, 1, args);
  assert.deepEqual(context.recent.slice(0, 3).map((r) => r.source.id), ['1', '2', '3']);
  assert.equal(context.recent[0].report.feedback_pain, 'Whole dated report');
  assert.ok(context.recent.length < 20);
  assert.ok(context.recent.length >= 3);
  assert.ok(context.recent.every((r) => r.planned.detalhes === undefined));
  assert.ok(context.omissions.some((r) => r.reason === 'selection_omissions'));
  assert.ok(context.sources.filter((r) => r.type === 'training').every((r) => r.version.length === 64));
  assert.ok(tokenBound(context) <= config.limits.AI_CONTEXT_TOKENS);
  assert.deepEqual(buildContext(db, 1, args), context);
});

test('whole reports and requested resources fail explicitly when required material cannot fit', (t) => {
  const { db, session, args } = fixture(t);
  session(1, '2026-10-13', '', 'yes', 'full report '.repeat(2000), 5);
  assert.throws(() => buildContext(db, 1, args), (e) => e.status === 413 && e.code === 'criticalContextTooLarge');
  db.prepare("UPDATE trainings SET feedback_pain=NULL,feedback_has_pain='no',feedback_rpe=2,detalhes=? WHERE id=1").run('Essential requested details '.repeat(2000));
  assert.throws(() => buildContext(db, 1, { ...args, purpose: 'analysis', resourceId: 1 }), (e) => e.status === 413);
});

test('no-pain, missing feedback and dated descriptions retain their original values without inferred recovery', (t) => {
  const { db, session, args } = fixture(t);
  session(1, '2026-10-13', '', 'no', null, 2);
  session(2, '2026-10-13', '');
  session(3, '2026-10-13', '');
  session(4, '2026-10-01', '', null, 'Earlier dated report', 1);
  const context = buildContext(db, 1, args);
  assert.deepEqual(context.recent.map((r) => r.source.id), ['4', '1', '3', '2']);
  assert.equal(context.recent[0].report.feedback_has_pain, null);
  assert.equal(context.recent[0].report.observedOn, '2026-10-01');
  assert.equal(context.recent[1].report.feedback_has_pain, 'no');
  assert.equal(context.recent[2].report.feedback_rpe, null);
  assert.ok(context.recent[2].gaps.includes('feedback_has_pain'));
  assert.equal(context.currentRestrictions, undefined);
  assert.ok(context.gaps[0].includes('do not establish resolution'));
});

test('requested sessions appear once and aggregate overlaps are labeled references, never additional totals', (t) => {
  const { db, session, args } = fixture(t);
  session(1, '2026-09-15', '', 'yes', 'Old dated report', 5);
  session(2, '2026-09-16', '', 'no', null, 2);
  const context = buildContext(db, 1, { ...args, purpose: 'analysis', resourceId: 1 });
  assert.equal(context.resource.source.id, '1');
  assert.equal(context.resource.includedInAggregates, true);
  assert.ok(context.comparables.every((r) => r.source.id !== '1' && r.includedInAggregates));
  assert.equal(context.weekly[0].completed, 2);
  assert.equal(context.weekly[0].distanceKm, 10);
  assert.equal(context.sources.filter((r) => r.type === 'training' && r.id === '1').length, 1);
  assert.ok(context.totalsPolicy.includes('references, never additional totals'));
  session(3, '2026-10-16', 'Requested future session');
  const future = buildContext(db, 1, { ...args, purpose: 'analysis', resourceId: 3 });
  assert.equal(future.resource.source.id, '3');
  assert.ok(future.upcoming.every((r) => r.source.id !== '3'));
});

test('selection bounds include final provenance, omissions and hash; v2 snapshots remain unchanged and outdated', (t) => {
  const { db, config, session, args } = fixture(t);
  session(1, '2026-10-13', 'Planning '.repeat(300), 'yes', 'Whole report', 5);
  for (let id = 2; id < 12; id++) session(id, '2026-10-12', 'Planning '.repeat(300), 'no', null, 1);
  const original = buildContext(db, 1, args);
  const legacy = { ...original, policyVersion: 'training-context-v2' };
  const frozen = JSON.stringify(legacy);
  assert.equal(contextIsCurrent(db, 1, legacy, config), false);
  assert.equal(JSON.stringify(legacy), frozen);
  for (const limit of [1000, 2000, 4000, 6000, 12000, 24000]) {
    config.limits.AI_CONTEXT_TOKENS = limit;
    try {
      const context = buildContext(db, 1, args);
      assert.ok(tokenBound(context) <= limit);
      assert.equal(context.recent[0].report.feedback_pain, 'Whole report');
      assert.deepEqual(buildContext(db, 1, args), context);
    } catch (e) {
      assert.equal(e.status, 413);
      assert.ok(['criticalContextTooLarge', 'contextTooLarge'].includes(e.code));
    }
  }
  db.prepare("UPDATE trainings SET feedback_pain='Corrected report' WHERE id=1").run();
  assert.equal(contextIsCurrent(db, 1, original, config), false);
});

test('lower-priority equipment is omitted explicitly after report and provenance reservation', (t) => {
  const { db, config, session, args } = fixture(t);
  config.limits.AI_CONTEXT_TOKENS = 4000;
  session(1, '2026-10-13', '', 'yes', 'Priority report', 5);
  for (let i = 0; i < 20; i++) db.prepare("INSERT INTO shoes(user_id,brand,model) VALUES (1,'Synthetic',?)").run(`Shoe ${i}`);
  const context = buildContext(db, 1, args);
  assert.equal(context.recent[0].report.feedback_pain, 'Priority report');
  assert.ok(context.shoes.length < 20);
  assert.ok(context.omissions.length);
  assert.ok(tokenBound(context) <= config.limits.AI_CONTEXT_TOKENS);
});


test('interpretations citing a newer dependency are selected after that dependency becomes current', (t) => {
  const { db, config, session, args } = fixture(t);
  session(1, '2026-10-13', '', 'no', null, 4);
  db.prepare(`INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
    VALUES ('prior-analysis',1,1,1,'workout-analysis-v1','{}','completed','en-US','2026-10-25T10:00:00.000Z')`).run();
  const context = buildContext(db, 1, args);
  const training = context.sources.find((ref) => ref.type === 'training' && ref.id === '1');
  assert.ok(training, 'the supporting training is in the bounded context');
  const insert = db.prepare(`INSERT INTO ai_interpretations
    (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
    VALUES (?,1,1,'prior-analysis','pattern',?,?,? ,? ,?,'pending',?,?)`);
  const aEvidence = [{ type: 'training', id: '1', version: training.version }];
  insert.run('interpretation-a', 'A is supported by the training.', JSON.stringify(aEvidence), 'evidence-a', 'hash-a', 'content-a', '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z');
  const a = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('interpretation-a');
  const bEvidence = [{ type: 'interpretation', id: a.id, version: hash(a) }];
  insert.run('interpretation-b', 'B is supported by A.', JSON.stringify(bEvidence), 'evidence-b', 'hash-b', 'content-b', '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z');
  const b = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('interpretation-b');
  const cEvidence = [{ type: 'interpretation', id: b.id, version: hash(b) }];
  insert.run('interpretation-c', 'C is supported by B.', JSON.stringify(cEvidence), 'evidence-c', 'hash-c', 'content-c', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z');

  const selected = buildContext(db, 1, args);
  assert.deepEqual(selected.interpretations.map((item) => item.source.id), ['interpretation-a', 'interpretation-b', 'interpretation-c']);
  assert.deepEqual(selected.interpretations.find((item) => item.source.id === 'interpretation-b').evidence, bEvidence);
  assert.deepEqual(selected.interpretations.find((item) => item.source.id === 'interpretation-c').evidence, cEvidence);
});


test('stale, unavailable, disposed, foreign and cyclic interpretation dependencies never become current', (t) => {
  const { db, config, session, args } = fixture(t);
  session(1, '2026-10-13', '', 'no', null, 4);
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES (2,'foreign@example.invalid','synthetic')").run();
  db.prepare(`INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
    VALUES ('prior-analysis',1,1,1,'workout-analysis-v1','{}','completed','en-US','2026-10-25T10:00:00.000Z'),
      ('foreign-analysis',2,1,1,'workout-analysis-v1','{}','completed','en-US','2026-10-25T10:00:00.000Z')`).run();
  const original = buildContext(db, 1, args).sources.find((ref) => ref.type === 'training' && ref.id === '1');
  const insert = db.prepare(`INSERT INTO ai_interpretations
    (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
    VALUES (?, ?, 1, ?, 'pattern', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (id, evidence, { user = 1, analysis = user === 1 ? 'prior-analysis' : 'foreign-analysis', disposition = 'pending', time = '2026-10-26T00:00:00.000Z' } = {}) =>
    insert.run(id, user, analysis, `Text ${id}`, JSON.stringify(evidence), `key-${id}`, `hash-${id}`, `content-${id}`, disposition, time, time);
  add('root', [{ type: 'training', id: '1', version: original.version }]);
  const root = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('root');
  add('stale-child', [{ type: 'interpretation', id: 'root', version: hash(root) }]);
  add('missing-child', [{ type: 'interpretation', id: 'missing', version: 'missing-version' }]);
  add('divergent-child', [{ type: 'interpretation', id: 'root', version: 'different-version' }]);
  add('dismissed-root', [{ type: 'training', id: '1', version: original.version }], { disposition: 'dismissed' });
  const dismissed = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('dismissed-root');
  add('dismissed-child', [{ type: 'interpretation', id: 'dismissed-root', version: hash(dismissed) }]);
  add('foreign-root', [{ type: 'training', id: '1', version: original.version }], { user: 2 });
  const foreign = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('foreign-root');
  add('foreign-child', [{ type: 'interpretation', id: 'foreign-root', version: hash(foreign) }]);
  add('cycle-a', [{ type: 'interpretation', id: 'cycle-b', version: 'cycle-b-version' }]);
  const cycleA = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('cycle-a');
  add('cycle-b', [{ type: 'interpretation', id: 'cycle-a', version: hash(cycleA) }]);

  const beforeSourceChange = buildContext(db, 1, args);
  assert.deepEqual(beforeSourceChange.interpretations.map((item) => item.source.id), ['root', 'stale-child']);
  assert.ok(!beforeSourceChange.interpretations.some((item) => ['missing-child', 'divergent-child', 'dismissed-child', 'foreign-child', 'cycle-a', 'cycle-b'].includes(item.source.id)));
  db.prepare("UPDATE trainings SET feedback_notas='Changed original source' WHERE id=1").run();
  const afterSourceChange = buildContext(db, 1, args);
  assert.equal(afterSourceChange.interpretations?.length || 0, 0, 'changed original evidence removes the root and its dependent');
});


test('an interpretation omitted by the context budget leaves no selected dependency reference', (t) => {
  const { db, config, session, args } = fixture(t);
  session(1, '2026-10-13', '', 'no', null, 4);
  db.prepare(`INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
    VALUES ('prior-analysis',1,1,1,'workout-analysis-v1','{}','completed','en-US','2026-10-25T10:00:00.000Z')`).run();
  const base = buildContext(db, 1, args);
  const training = base.sources.find((ref) => ref.type === 'training' && ref.id === '1');
  const insert = db.prepare(`INSERT INTO ai_interpretations
    (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
    VALUES (?,1,1,'prior-analysis','pattern',?,?,?, ?,?,'pending',?,?)`);
  const rootEvidence = [{ type: 'training', id: '1', version: training.version }];
  insert.run('budget-root', 'Root supported by the training. '.repeat(32), JSON.stringify(rootEvidence), 'budget-root-key', 'budget-root-hash', 'budget-root-content', '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z');
  const root = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('budget-root');
  const childEvidence = [{ type: 'interpretation', id: root.id, version: hash(root) }];
  insert.run('budget-child', 'Dependent conclusion '.repeat(220), JSON.stringify(childEvidence), 'budget-child-key', 'budget-child-hash', 'budget-child-content', '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z');
  const child = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('budget-child');
  const grandchildEvidence = [{ type: 'interpretation', id: child.id, version: hash(child) }];
  insert.run('budget-grandchild', 'Grandchild conclusion.', JSON.stringify(grandchildEvidence), 'budget-grandchild-key', 'budget-grandchild-hash', 'budget-grandchild-content', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z');
  const grandchild = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('budget-grandchild');
  const leafEvidence = [{ type: 'interpretation', id: grandchild.id, version: hash(grandchild) }];
  insert.run('budget-leaf', 'Leaf conclusion.', JSON.stringify(leafEvidence), 'budget-leaf-key', 'budget-leaf-hash', 'budget-leaf-content', '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z');
  let bounded = null;
  for (let budget = 3000; budget <= 20000 && !bounded; budget += 100) {
    const candidateConfig = structuredClone(config);
    candidateConfig.limits.AI_CONTEXT_TOKENS = budget;
    try {
      const candidate = buildContext(db, 1, { ...args, config: candidateConfig });
      const ids = candidate.interpretations?.map((item) => item.source.id) || [];
      if (ids.includes('budget-root') && !ids.includes('budget-child')) bounded = candidate;
    } catch (error) {
      if (!['contextTooLarge', 'criticalContextTooLarge'].includes(error.code)) throw error;
    }
  }
  assert.ok(bounded, 'a finite optional budget can select the root while excluding its oversized dependent');
  const selectedIds = new Set(bounded.interpretations.map((item) => item.source.id));
  assert.ok(bounded.sources.filter((ref) => ref.type === 'interpretation').every((ref) => selectedIds.has(ref.id)));
  assert.ok(bounded.omissions.some((item) => item.type === 'interpretation' && item.reason === 'context_budget'));
  let fullyBlocked = null;
  for (let budget = 3000; budget <= 20000 && !fullyBlocked; budget += 100) {
    const candidateConfig = structuredClone(config);
    candidateConfig.limits.AI_CONTEXT_TOKENS = budget;
    try {
      const candidate = buildContext(db, 1, { ...args, config: candidateConfig });
      const omitted = candidate.omissions.filter((item) => item.type === 'interpretation' && item.reason === 'context_budget').length;
      if (!candidate.interpretations?.length && omitted === 4) fullyBlocked = candidate;
    } catch (error) {
      if (!['contextTooLarge', 'criticalContextTooLarge'].includes(error.code)) throw error;
    }
  }
  assert.ok(fullyBlocked, 'a budget that excludes the root also excludes its complete dependent chain');
  assert.deepEqual(fullyBlocked.sources.filter((ref) => ref.type === 'interpretation'), []);
});
