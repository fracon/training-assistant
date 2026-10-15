'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { readAiConfig } = require('../src/ai/config');
const { buildContext, contextIsCurrent, tokenBound } = require('../src/ai/context');

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
