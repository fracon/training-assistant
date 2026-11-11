'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/public/shared/memory-insights.js')));
const session = (date, { completed = true, km = 8, duration = '45:00', rpe = 3, priority = null, href = `/training-result.html?id=${date}`, included = false } = {}) => ({
  date, href, priority, includedInAggregates: included,
  actual: { completed, fit_distance: completed ? km : null, fit_duration: completed ? duration : null },
  report: { feedback_rpe: completed ? rpe : null },
});

test('weeks start on Monday and durations parse h:mm:ss or mm:ss only', async () => {
  const { mondayOf, durationSeconds } = await load();
  assert.equal(mondayOf('2026-11-11'), '2026-11-09');
  assert.equal(mondayOf('2026-11-15'), '2026-11-09');
  assert.equal(mondayOf('2026-11-16'), '2026-11-16');
  assert.equal(durationSeconds('45:00'), 2700);
  assert.equal(durationSeconds('1:36:40'), 5800);
  for (const value of [null, '', '45', '1:75:00', 'abc']) assert.equal(durationSeconds(value), null);
});

test('the weekly series joins aggregated weeks with detailed recent sessions without double counting', async () => {
  const { weeklySeries } = await load();
  const memory = {
    asOf: '2026-11-11',
    weekly: [{ weekStart: '2026-10-19', distanceKm: 20, durationSeconds: 7200, completed: 2, planned: 3, averageRpe: 3, rpeReports: 2 },
      { weekStart: '2026-10-26', distanceKm: 10, durationSeconds: 3600, completed: 1, planned: 1, averageRpe: null, rpeReports: 0 }],
    recent: [session('2026-10-30'), session('2026-11-09', { rpe: 5 }), session('2026-11-11', { completed: false }), session('2026-11-20')],
    task: { session: session('2026-10-20', { included: true }) },
  };
  const series = weeklySeries(memory, 4);
  assert.deepEqual(series.map((week) => week.weekStart), ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
  assert.deepEqual(series.map((week) => [week.distanceKm, week.completed, week.planned]), [[20, 2, 3], [18, 2, 2], [0, 0, 0], [8, 1, 2]]);
  assert.equal(series[0].averageRpe, 3);
  assert.equal(series[1].averageRpe, 3, 'unknown aggregate effort does not dilute the recent report');
  assert.equal(series[2].averageRpe, null);
  assert.equal(series[3].averageRpe, 5);
  const counted = weeklySeries({ ...memory, task: { session: session('2026-11-10', { km: 5 }) } }, 4);
  assert.equal(counted[3].distanceKm, 13, 'an analyzed session outside the totals is counted once');
});

test('the summary reports volume, consistency, effort trend and concerns, and flags a partial selection', async () => {
  const { memorySummary } = await load();
  const memory = {
    asOf: '2026-11-11',
    weekly: [{ weekStart: '2026-10-19', distanceKm: 20, durationSeconds: 7200, completed: 2, planned: 2, averageRpe: 2, rpeReports: 2 }],
    recent: [session('2026-10-27', { rpe: 2 }), session('2026-11-03', { rpe: 4 }), session('2026-11-09', { rpe: 4, priority: 'concern' }),
      session('2026-11-05', { priority: 'concern' }), session('2026-11-10', { completed: false })],
    omissions: { budget: {} },
  };
  const summary = memorySummary(memory);
  assert.equal(summary.volume.distanceKm, 52);
  assert.deepEqual(summary.consistency, { completed: 6, planned: 7, ratio: 6 / 7 });
  assert.equal(summary.effort.trend, 'up');
  assert.equal(summary.concerns.count, 2);
  assert.equal(summary.concerns.latest.date, '2026-11-09');
  assert.equal(summary.partial, false);
  const flat = memorySummary({ ...memory, weekly: [], recent: [session('2026-10-27', { rpe: 3 }), session('2026-11-09', { rpe: 3 })] });
  assert.equal(flat.effort.trend, 'flat');
  const down = memorySummary({ ...memory, weekly: [], recent: [session('2026-10-27', { rpe: 4 }), session('2026-11-09', { rpe: 2 })] });
  assert.equal(down.effort.trend, 'down');
  // Effort is weighted by RPE reports, never by completed sessions without one (Codex review on #96).
  const sparse = memorySummary({ asOf: '2026-11-11', omissions: { budget: {} },
    weekly: [{ weekStart: '2026-10-26', distanceKm: 50, durationSeconds: 18000, completed: 10, planned: 10, averageRpe: 1, rpeReports: 1 }],
    recent: [session('2026-11-02', { rpe: 5 })] });
  assert.equal(sparse.effort.previous, 1);
  assert.equal(sparse.effort.recent, 5);
  const across = memorySummary({ asOf: '2026-11-03', omissions: { budget: {} },
    weekly: [{ weekStart: '2026-10-26', distanceKm: 50, durationSeconds: 18000, completed: 10, planned: 10, averageRpe: 1, rpeReports: 1 }],
    recent: [session('2026-11-02', { rpe: 5 })] });
  assert.equal(across.effort.recent, 3, 'one report of 1 and one of 5 average 3, not 1.36');
  // An old analyzed workout's discomfort is not a current alert (Codex review on #96).
  const oldConcern = memorySummary({ asOf: '2026-11-11', omissions: { budget: {} }, recent: [],
    task: { session: session('2025-01-15', { priority: 'concern', included: false }) } });
  assert.equal(oldConcern.concerns.count, 0);
  const currentConcern = memorySummary({ asOf: '2026-11-11', omissions: { budget: {} }, recent: [],
    task: { session: session('2026-11-09', { priority: 'concern' }) } });
  assert.equal(currentConcern.concerns.count, 1);
  // Omitted weekly totals make the summary partial too: those weeks are unknown, not zero.
  assert.equal(memorySummary({ asOf: '2026-11-11', omissions: { budget: { weekly: 3 } } }).partial, true);
  const empty = memorySummary({ asOf: '2026-11-11', omissions: { budget: { recent: 2 } } });
  assert.deepEqual(empty.consistency, { completed: 0, planned: 0, ratio: null });
  assert.equal(empty.effort.trend, null);
  assert.equal(empty.concerns.latest, null);
  assert.equal(empty.partial, true);
});

test('the quality checklist names what to fix and where', async () => {
  const { memoryQuality } = await load();
  const day = (name, canTrain = true) => ({ day: name, canTrain, periods: canTrain ? ['before_08'] : [], minutes: canTrain ? 60 : null, location: canTrain ? 'SP' : '' });
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((name, i) => day(name, i % 2 === 0));
  const complete = {
    purpose: 'workouts', asOf: '2026-11-11', availability: days, cycle: { objective: 'Goal' },
    recent: [session('2026-11-09')], profile: { fields: { experience: { value: 'Three years.' } } },
    appliedPlan: { outdated: false, compatibilityError: null },
  };
  assert.ok(memoryQuality(complete).every((item) => item.ok));
  const gaps = memoryQuality({
    ...complete, availability: [...days.slice(0, 6), { ...day('sunday'), periods: ['before_08', '08_12'] }], cycle: null,
    recent: [session('2026-11-09', { rpe: null, href: '/r?id=1' }), session('2026-11-08', { completed: false, href: '/r?id=2' }), session('2026-11-11', { completed: false })],
    profile: { fields: {} }, appliedPlan: { outdated: true, compatibilityError: null },
  });
  assert.deepEqual(gaps.map((item) => [item.key, item.ok]), [['availability', false], ['cycle', false], ['effort', false], ['results', false], ['experience', false], ['plan', false]]);
  assert.equal(gaps.find((item) => item.key === 'effort').href, '/r?id=1');
  assert.equal(gaps.find((item) => item.key === 'results').count, 1, 'today\'s planned session is not overdue');
  assert.equal(gaps.find((item) => item.key === 'plan').state, 'outdated');
  assert.equal(memoryQuality({ ...complete, appliedPlan: null }).at(-1).state, 'none');
  assert.equal(memoryQuality({ ...complete, appliedPlan: { compatibilityError: 'x' } }).at(-1).state, 'incompatible');
  assert.equal(memoryQuality({ ...complete, purpose: 'cycle' }).some((item) => item.key === 'plan'), false);
  // The analyzed workout counts as recent when inside the recent period, once (Codex review on #96).
  const analysisTab = { ...complete, purpose: 'analysis', ranges: { detailedFrom: '2026-10-29' }, recent: [],
    task: { session: session('2026-11-09', { rpe: null, href: '/r?id=9' }) } };
  const effortItem = memoryQuality(analysisTab).find((item) => item.key === 'effort');
  assert.deepEqual([effortItem.ok, effortItem.count, effortItem.href], [false, 1, '/r?id=9']);
  const oldAnalysis = memoryQuality({ ...analysisTab, task: { session: session('2025-01-15', { rpe: null }) } });
  assert.equal(oldAnalysis.find((item) => item.key === 'effort').ok, true, 'an old analyzed workout is not a recent gap');
  const bare = memoryQuality({ purpose: 'cycle', asOf: '2026-11-11' });
  assert.equal(bare.find((item) => item.key === 'effort').href, '/calendar.html');
});
