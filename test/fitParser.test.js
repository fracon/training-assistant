'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFitFile,
  summarize,
  resolveStepType,
  formatDuration,
  formatPace,
  formatDistance,
  normalizeCalories,
  resolveActivityTotals,
  resolveAscent,
} = require('../src/fitParser');

function makeLap(overrides = {}) {
  return {
    message_index: 0,
    intensity: 'active',
    total_elapsed_time: 600.4,
    total_distance: 2000,
    max_speed: 24,
    avg_heart_rate: 150,
    max_heart_rate: 162,
    total_ascent: 10,
    total_descent: 4,
    avg_running_cadence: 88,
    max_running_cadence: 92,
    avg_stride_length: 1.1,
    total_calories: 60,
    ...overrides,
  };
}

function makeSession(laps, overrides = {}) {
  return {
    sport: 'running',
    start_time: new Date('2026-02-03T07:30:00Z'),
    timestamp: new Date('2026-02-03T08:10:00Z'),
    laps,
    ...overrides,
  };
}

test('formatDuration renders mm:ss and h:mm:ss labels', () => {
  assert.equal(formatDuration(Number.NaN), '--:--');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '--:--');
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(-42), '00:00');
  assert.equal(formatDuration(65.4), '01:05');
  assert.equal(formatDuration(3599.6), '1:00:00');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('formatPace renders min/km labels with rounding', () => {
  assert.equal(formatPace(Number.NaN), '--:--');
  assert.equal(formatPace(0), '--:--');
  assert.equal(formatPace(-3), '--:--');
  assert.equal(formatPace(270), '4:30');
  assert.equal(formatPace(300.4), '5:00');
  assert.equal(formatPace(299.5), '5:00', 'half seconds round up to the next second');
  assert.equal(formatPace(299.7), '5:00');
});

test('formatDistance renders km labels', () => {
  assert.equal(formatDistance(null), '-');
  assert.equal(formatDistance(0), '0.00');
  assert.equal(formatDistance(1.2344), '1.23');
});

test('normalizeCalories preserves valid zero, rounds fractions, and rejects missing or unsafe values', () => {
  assert.equal(normalizeCalories(454), 454);
  assert.equal(normalizeCalories(0), 0);
  assert.equal(normalizeCalories(12.6), 13);
  for (const value of [null, undefined, '', Number.NaN, Number.POSITIVE_INFINITY, -1, 'not-a-number']) {
    assert.equal(normalizeCalories(value), null);
  }
});

test('resolveStepType maps intensity and sub_sport to workout steps', () => {
  assert.equal(resolveStepType({ intensity: 'warmup' }), 'Warmup');
  assert.equal(resolveStepType({ sub_sport: 'warm_up' }), 'Warmup');
  assert.equal(resolveStepType({ intensity: 'cooldown' }), 'Cooldown');
  assert.equal(resolveStepType({ intensity: 'rest' }), 'Rest');
  assert.equal(resolveStepType({ sub_sport: 'recovery' }), 'Rest');
  assert.equal(resolveStepType({ intensity: 'active' }), 'Run');
  assert.equal(resolveStepType({}), 'Run');
});

test('summarize builds cumulative lap views from session data', () => {
  const summary = summarize({
    sessions: [
      makeSession([
        makeLap(),
        makeLap({ message_index: 1, intensity: 'rest', total_elapsed_time: 120, total_distance: 0, max_speed: 12 }),
        makeLap({ message_index: 2, total_elapsed_time: 480.2, total_distance: 1600 }),
      ], { total_calories: 0.4 }),
    ],
  });

  assert.deepEqual(summary.activity, {
    sport: 'running',
    startTime: '2026-02-03T07:30:00.000Z',
    endTime: '2026-02-03T08:10:00.000Z',
  });
  assert.equal(summary.laps.length, 3);

  const [first, rest, third] = summary.laps;
  assert.equal(first.stepType, 'Run');
  assert.equal(first.lap, 1);
  assert.equal(first.durationLabel, '10:00');
  assert.equal(first.cumulativeLabel, '10:00');
  assert.equal(first.distanceLabel, '2.00');
  assert.equal(first.avgPaceLabel, '5:00');
  assert.equal(first.bestPaceLabel, '2:30');
  assert.equal(first.avgHeartRate, 150);
  assert.equal(first.maxHeartRate, 162);
  assert.equal(first.ascentMeters, 10);
  assert.equal(first.descentMeters, 4);
  assert.equal(first.avgCadenceSpm, 88);
  assert.equal(first.maxCadenceSpm, 92);
  assert.equal(first.strideMeters, 1.1);
  assert.equal(first.calories, 60);

  assert.equal(rest.stepType, 'Rest');
  assert.equal(rest.distanceKm, 0);
  assert.equal(rest.distanceLabel, '0.00');
  assert.equal(rest.avgPaceSecondsPerKm, null);
  assert.equal(rest.avgPaceLabel, '--:--');
  assert.equal(rest.cumulativeLabel, '12:00');

  assert.equal(third.lap, 3);
  assert.equal(third.durationLabel, '08:00');
  assert.equal(third.cumulativeLabel, '20:01');

  assert.deepEqual(summary.totals, {
    durationSeconds: 1200.6,
    durationLabel: '20:01',
    distanceKm: 3.6,
    distanceLabel: '3.60',
    avgPaceSecondsPerKm: 333.5,
    avgPaceLabel: '5:34',
    avgHeartRate: 150,
    maxHeartRate: 162,
    ascentMeters: 30,
    calories: 0,
  });
});

test('summarize tolerates missing fields and falls back gracefully', () => {
  const emptySummary = summarize(undefined);
  assert.equal(emptySummary.activity.sport, null);
  assert.equal(emptySummary.activity.startTime, null);
  assert.equal(emptySummary.activity.endTime, null);
  assert.deepEqual(emptySummary.laps, []);
  assert.deepEqual(emptySummary.totals, {
    durationSeconds: 0,
    durationLabel: '00:00',
    distanceKm: null,
    distanceLabel: '-',
    avgPaceSecondsPerKm: null,
    avgPaceLabel: '--:--',
    avgHeartRate: null,
    maxHeartRate: null,
    ascentMeters: null,
    calories: null,
  });

  const noLaps = summarize({ sessions: [{ sport: 'cycling' }] });
  assert.deepEqual(noLaps.laps, []);

  const activityFallback = summarize({ activity: { sport: 'running' }, sessions: [{}] });
  assert.equal(activityFallback.activity.sport, 'running');

  const sparse = summarize({
    sessions: [
      {
        start_time: 'not-a-date',
        laps: [{}, null, { avg_cadence: 80, max_cadence: 90 }],
      },
    ],
  });
  assert.equal(sparse.activity.sport, null);
  assert.equal(sparse.activity.startTime, null);
  const [blank, emptySlot, cadenceOnly] = sparse.laps;
  assert.equal(emptySlot.stepType, 'Run');
  assert.equal(blank.stepType, 'Run');
  assert.equal(blank.durationLabel, '--:--');
  assert.equal(blank.cumulativeLabel, '00:00');
  assert.equal(blank.distanceLabel, '-');
  assert.equal(cadenceOnly.avgCadenceSpm, 80);
  assert.equal(cadenceOnly.maxCadenceSpm, 90);
  assert.equal(cadenceOnly.avgHeartRate, null);
});

test('summarize computes totals across mixed lap quality', () => {
  const summary = summarize({
    sessions: [
      {
        sport: 'running',
        start_time: new Date('2026-02-03T07:30:00Z'),
        laps: [
          makeLap({ total_elapsed_time: 600, total_distance: 2000 }),
          makeLap({
            message_index: 1,
            intensity: 'rest',
            total_elapsed_time: 0,
            total_distance: 0,
            avg_heart_rate: 140,
          }),
          makeLap({
            message_index: 2,
            total_elapsed_time: 60,
            total_distance: 1000,
            avg_heart_rate: null,
            max_heart_rate: null,
            total_ascent: null,
          }),
        ],
      },
    ],
  });

  assert.deepEqual(summary.totals, {
    durationSeconds: 660,
    durationLabel: '11:00',
    distanceKm: 3,
    distanceLabel: '3.00',
    avgPaceSecondsPerKm: 220,
    avgPaceLabel: '3:40',
    avgHeartRate: 150,
    maxHeartRate: 162,
    ascentMeters: null,
    calories: null,
  });
});

test('summarize reports zero-distance workouts without a pace average', () => {
  const treadmill = summarize({
    sessions: [{ laps: [makeLap({ total_distance: 0 })] }],
  });
  assert.equal(treadmill.totals.distanceKm, 0);
  assert.equal(treadmill.totals.distanceLabel, '0.00');
  assert.equal(treadmill.totals.avgPaceSecondsPerKm, null);
  assert.equal(treadmill.totals.avgPaceLabel, '--:--');
  assert.equal(treadmill.totals.durationLabel, '10:00');
});

test('invalid negative lap distance, duration, ascent and descent are excluded from display totals', () => {
  const summary = summarize({ sessions: [{ laps: [makeLap({
    total_timer_time: -1, total_elapsed_time: -2, total_distance: -100,
    total_ascent: -20, total_descent: -30,
  })] }] });
  assert.equal(summary.laps[0].duration, null);
  assert.equal(summary.laps[0].distanceKm, null);
  assert.equal(summary.laps[0].ascentMeters, null);
  assert.equal(summary.laps[0].descentMeters, null);
  assert.equal(summary.totals.distanceKm, null);
  assert.equal(summary.totals.ascentMeters, null);
});

test('summarize skips pace when no lap carries a duration', () => {
  const distanceOnly = summarize({
    sessions: [
      { laps: [makeLap({ total_elapsed_time: undefined, total_distance: 1000 })] },
    ],
  });
  assert.equal(distanceOnly.totals.durationSeconds, 0);
  assert.equal(distanceOnly.totals.durationLabel, '00:00');
  assert.equal(distanceOnly.totals.distanceKm, null, 'a distance without a compatible duration is not used alone');
  assert.equal(distanceOnly.totals.avgPaceLabel, '--:--');
});

test('activity summary prefers session timer and distance, rounds pace to the nearest second', () => {
  const summary = summarize({ sessions: [{
    total_timer_time: 5401.707,
    total_elapsed_time: 5401.707,
    total_distance: 13785.17,
    total_ascent: 320,
    avg_speed: 9.1872,
    laps: [makeLap({ total_timer_time: 5401.707, total_elapsed_time: 5401.707, total_distance: 13786, total_ascent: 317 })],
  }] });
  assert.equal(summary.totals.durationSeconds, 5401.71);
  assert.equal(summary.totals.durationLabel, '1:30:02');
  assert.equal(summary.totals.distanceKm, 13.785);
  assert.equal(summary.totals.avgPaceSecondsPerKm, 391.8);
  assert.equal(summary.totals.avgPaceLabel, '6:32');
  assert.equal(summary.totals.ascentMeters, 320);
});

test('timer time wins over elapsed time and elapsed is the session fallback', () => {
  const timer = summarize({ sessions: [{
    total_timer_time: 1500, total_elapsed_time: 1800, total_distance: 5000,
    laps: [makeLap({ total_timer_time: 1500, total_elapsed_time: 1800, total_distance: 5000 })],
  }] });
  assert.equal(timer.totals.durationSeconds, 1500);
  assert.equal(timer.totals.avgPaceLabel, '5:00');

  const elapsed = resolveActivityTotals({ total_timer_time: Number.NaN, total_elapsed_time: 1800, total_distance: 5000 }, [], [], []);
  assert.deepEqual(elapsed, { durationSeconds: 1800, distanceKm: 5 });
  assert.deepEqual(resolveActivityTotals({ total_timer_time: -1, total_elapsed_time: 0, total_distance: 5000, avg_speed: 10 }, [], [], []), {
    durationSeconds: 1800, distanceKm: 5,
  });
});

test('consistent laps are a same-source fallback before records', () => {
  assert.deepEqual(resolveActivityTotals({}, [
    { total_timer_time: 300, total_elapsed_time: 400, total_distance: 1000 },
    { total_timer_time: 600, total_elapsed_time: 700, total_distance: 2000 },
  ], [], []), { durationSeconds: 900, distanceKm: 3 });
  assert.deepEqual(resolveActivityTotals({}, [
    { total_elapsed_time: 300, total_distance: 1000 },
    { total_elapsed_time: 600, total_distance: 2000 },
  ], [], []), { durationSeconds: 900, distanceKm: 3 });
  assert.equal(resolveActivityTotals({}, [{ total_timer_time: 300, total_distance: 1000 }, { total_distance: 500 }], [], []), null);
  assert.equal(resolveActivityTotals({}, [{ total_timer_time: 0, total_distance: 0 }], [], []), null);
  assert.equal(resolveActivityTotals({}, [
    { total_timer_time: Number.MAX_VALUE, total_distance: 1000 },
    { total_timer_time: Number.MAX_VALUE, total_distance: 1000 },
  ], [], []), null, 'non-finite aggregate sums are not accepted as lap totals');
  assert.equal(resolveActivityTotals({}, [
    { total_timer_time: 1, total_distance: Number.MAX_VALUE },
    { total_timer_time: 1, total_distance: Number.MAX_VALUE },
  ], [], []), null, 'non-finite aggregate distance is not accepted');
});

test('zero lap timer totals fall back consistently to elapsed time', () => {
  const summary = summarize({ sessions: [makeSession([
    makeLap({ total_timer_time: 0, total_elapsed_time: 30, total_distance: 500 }),
    makeLap({ message_index: 1, total_timer_time: 0, total_elapsed_time: 45, total_distance: 750 }),
  ])] });

  assert.equal(summary.totals.durationSeconds, 75);
  assert.equal(summary.totals.distanceKm, 1.25);
  assert.equal(summary.totals.avgPaceSecondsPerKm, 60);
  assert.equal(summary.totals.avgPaceLabel, '1:00');
  assert.deepEqual(summary.laps.map(({ duration, durationLabel, cumulativeLabel }) => ({ duration, durationLabel, cumulativeLabel })), [
    { duration: 30, durationLabel: '00:30', cumulativeLabel: '00:30' },
    { duration: 45, durationLabel: '00:45', cumulativeLabel: '01:15' },
  ]);
});

test('positive lap timer remains preferred over positive elapsed and drives cumulative views', () => {
  const summary = summarize({ sessions: [makeSession([
    makeLap({ total_timer_time: 20, total_elapsed_time: 30, total_distance: 500 }),
    makeLap({ message_index: 1, total_timer_time: 40, total_elapsed_time: 50, total_distance: 1000 }),
  ])] });

  assert.equal(summary.totals.durationSeconds, 60);
  assert.equal(summary.totals.distanceKm, 1.5);
  assert.equal(summary.totals.avgPaceSecondsPerKm, 40);
  assert.deepEqual(summary.laps.map(({ duration, cumulativeSeconds, cumulativeLabel }) => ({ duration, cumulativeSeconds, cumulativeLabel })), [
    { duration: 20, cumulativeSeconds: 20, cumulativeLabel: '00:20' },
    { duration: 40, cumulativeSeconds: 60, cumulativeLabel: '01:00' },
  ]);
});

test('a zero timer on a distance-bearing lap rejects the entire timer aggregate', () => {
  const summary = summarize({ sessions: [makeSession([
    makeLap({ total_timer_time: 0, total_elapsed_time: 300, total_distance: 1000 }),
    makeLap({ message_index: 1, total_timer_time: 300, total_elapsed_time: 300, total_distance: 1000 }),
  ])] });

  assert.equal(summary.totals.durationSeconds, 600);
  assert.equal(summary.totals.distanceKm, 2);
  assert.equal(summary.totals.avgPaceLabel, '5:00');
});

test('zero-distance rest laps do not invalidate timer totals or add elapsed time', () => {
  const summary = summarize({ sessions: [makeSession([
    makeLap({ total_timer_time: 100, total_elapsed_time: 100, total_distance: 1000 }),
    makeLap({ message_index: 1, intensity: 'rest', total_timer_time: 0, total_elapsed_time: 200, total_distance: 0 }),
  ])] });

  assert.equal(summary.totals.durationSeconds, 100);
  assert.equal(summary.totals.distanceKm, 1);
  assert.equal(summary.totals.avgPaceLabel, '1:40');
  assert.deepEqual(summary.laps.map(({ duration, cumulativeSeconds }) => ({ duration, cumulativeSeconds })), [
    { duration: 100, cumulativeSeconds: 100 },
    { duration: 200, cumulativeSeconds: 300 },
  ]);

  const timedRest = summarize({ sessions: [makeSession([
    makeLap({ total_timer_time: 100, total_elapsed_time: 100, total_distance: 1000 }),
    makeLap({ message_index: 1, intensity: 'rest', total_timer_time: 20, total_elapsed_time: 120, total_distance: 0 }),
  ])] });
  assert.equal(timedRest.totals.durationSeconds, 120);
  assert.equal(timedRest.totals.distanceKm, 1);
  assert.equal(timedRest.totals.avgPaceLabel, '2:00');
});

test('lap elapsed fallback requires a complete set and otherwise uses record totals', () => {
  const laps = [
    { total_timer_time: 0, total_elapsed_time: 10, total_distance: 500 },
    { total_timer_time: 0, total_distance: 500 },
  ];
  const records = [
    { timestamp: 1704067200000, distance: 0 },
    { timestamp: 1704067210000, distance: 500 },
  ];
  assert.deepEqual(resolveActivityTotals({}, laps, records, []), { durationSeconds: 10, distanceKm: 0.5 });
});

test('invalid or zero lap durations do not create pace and records remain the fallback', () => {
  const zeroDuration = summarize({ sessions: [makeSession([
    makeLap({ total_timer_time: 0, total_elapsed_time: 0, total_distance: 1000 }),
  ])] });
  assert.equal(zeroDuration.laps[0].duration, 0);
  assert.equal(zeroDuration.laps[0].durationLabel, '00:00');
  assert.equal(zeroDuration.laps[0].avgPaceSecondsPerKm, null);
  assert.equal(zeroDuration.laps[0].avgPaceLabel, '--:--');
  assert.equal(zeroDuration.totals.durationSeconds, 0);
  assert.equal(zeroDuration.totals.avgPaceSecondsPerKm, null);
  assert.equal(zeroDuration.totals.avgPaceLabel, '--:--');

  const invalidLaps = [
    { total_timer_time: 0, total_elapsed_time: Number.NaN, total_distance: 500 },
    { total_timer_time: 0, total_elapsed_time: -5, total_distance: 500 },
  ];
  assert.deepEqual(resolveActivityTotals({}, invalidLaps, [
    { timestamp: 1704067200000, distance: 0 },
    { timestamp: 1704067210000, distance: 500 },
  ], []), { durationSeconds: 10, distanceKm: 0.5 });
});

test('missing timer and invalid values retain elapsed fallback while invalid lap data is rejected', () => {
  const summary = summarize({ sessions: [makeSession([
    makeLap({ total_timer_time: undefined, total_elapsed_time: 12, total_distance: 300 }),
    makeLap({ total_timer_time: Number.POSITIVE_INFINITY, total_elapsed_time: 18, total_distance: 700 }),
  ])] });
  assert.equal(summary.totals.durationSeconds, 30);
  assert.equal(summary.totals.distanceKm, 1);
  assert.equal(summary.totals.avgPaceLabel, '0:30');
  assert.deepEqual(summary.laps.map((lap) => lap.duration), [12, 18]);

  const invalid = summarize({ sessions: [makeSession([
    makeLap({ total_timer_time: -1, total_elapsed_time: -2, total_distance: 1000 }),
  ])] });
  assert.equal(invalid.laps[0].duration, null);
  assert.equal(invalid.laps[0].avgPaceLabel, '--:--');
  assert.equal(invalid.totals.durationSeconds, 0);
});

test('partially missing or invalid timers reject the whole timer set for complete elapsed totals', () => {
  for (const timer of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const summary = summarize({ sessions: [makeSession([
      makeLap({ total_timer_time: timer, total_elapsed_time: 300, total_distance: 1000 }),
      makeLap({ message_index: 1, total_timer_time: 300, total_elapsed_time: 300, total_distance: 1000 }),
    ])] });
    assert.equal(summary.totals.durationSeconds, 600, `timer ${String(timer)} must reject the mixed timer set`);
    assert.equal(summary.totals.distanceKm, 2);
    assert.equal(summary.totals.avgPaceLabel, '5:00');
  }
});

test('records provide a controlled distance and active-time fallback', () => {
  const records = [
    { timestamp: new Date('2026-01-01T00:00:00Z'), distance: 0 },
    { timestamp: new Date('2026-01-01T00:00:10Z'), distance: 500 },
    { timestamp: new Date('2026-01-01T00:00:20Z'), distance: 400 },
    { timestamp: new Date('2026-01-01T00:00:30Z'), distance: 900 },
  ];
  assert.deepEqual(resolveActivityTotals({}, [], records, [
    { event: 'timer', event_type: 'start', timestamp: new Date('2026-01-01T00:00:00Z') },
    { event: 'timer', event_type: 'stop', timestamp: new Date('2026-01-01T00:00:12Z') },
    { event: 'timer', event_type: 'resume', timestamp: new Date('2026-01-01T00:00:20Z') },
    { event: 'timer', event_type: 'stop_all', timestamp: new Date('2026-01-01T00:00:30Z') },
  ]), { durationSeconds: 22, distanceKm: 1 });
  assert.deepEqual(resolveActivityTotals({}, [], records, []), { durationSeconds: 30, distanceKm: 1 });
  assert.equal(resolveActivityTotals({}, [], [{ timestamp: 'bad', distance: 1 }, null], []), null);
  assert.equal(resolveActivityTotals({}, [], [{ timestamp: 1, distance: -1 }, { timestamp: 2, distance: 2 }], []), null);
  const equalTime = [
    { timestamp: 1704067200000, distance: 0 },
    { timestamp: 1704067200000, distance: 100 },
  ];
  assert.equal(resolveActivityTotals({}, [], equalTime, null), null, 'zero elapsed records cannot provide a duration');
  assert.equal(resolveActivityTotals({}, [], [
    { timestamp: new Date(Number.NaN), distance: 0 },
    { timestamp: Number.NaN, distance: 50 },
    { timestamp: ' ', distance: 100 },
    { timestamp: 'not-a-date', distance: 200 },
  ], []), null, 'invalid Date and strings are ignored');
  assert.deepEqual(resolveActivityTotals({}, [], [
    { timestamp: 1704067200000, distance: 0 },
    { timestamp: 1704067210000, distance: 500 },
  ], null), { durationSeconds: 10, distanceKm: 0.5 }, 'finite numeric timestamps and a non-array event source use elapsed fallback');
  assert.deepEqual(resolveActivityTotals({}, [], [
    { timestamp: '2026-01-01T00:00:00Z', distance: 0 },
    { timestamp: '2026-01-01T00:00:10Z', distance: 500 },
  ], [
    { event: 'timer', event_type: 'start', timestamp: '2026-01-01T00:00:00Z' },
  ]), { durationSeconds: 10, distanceKm: 0.5 }, 'an open timer interval ends at the last record');
  assert.equal(resolveActivityTotals({}, [], [
    { timestamp: 1704067200000, distance: 0 },
    { timestamp: 1704067210000, distance: 500 },
  ], [
    { event: 'timer', event_type: 'stop_all', timestamp: 1704067205000 },
  ]), null, 'stop without a preceding start contributes no active duration');
  assert.equal(resolveActivityTotals({}, [], [
    { timestamp: 1704067200000, distance: 0 },
    { timestamp: 1704067200000, distance: 500 },
  ], [
    { event: 'timer', event_type: 'start', timestamp: 1704067200000 },
    { event: 'timer', event_type: 'stop', timestamp: 1704067200000 },
  ]), null, 'zero-length timer intervals cannot supply activity duration');
});

test('ascent uses only valid positive rises and prefers session then complete laps', () => {
  const altitudes = [100, 120, 110, 90, 105, 105].map((altitude) => ({ altitude }));
  assert.equal(resolveAscent({ total_ascent: 40 }, [{ total_ascent: 99 }], altitudes), 40);
  assert.equal(resolveAscent({ total_ascent: 0 }, [], altitudes), 0);
  assert.equal(resolveAscent({ total_ascent: -1 }, [{ total_ascent: 12 }, { total_ascent: 8 }], altitudes), 20);
  assert.equal(resolveAscent({}, [{ total_ascent: 12 }, { total_ascent: null }], altitudes), 35);
  assert.equal(resolveAscent({}, [], [
    { enhanced_altitude: 100, altitude: 500 },
    { enhanced_altitude: 125, altitude: 510 },
    { enhanced_altitude: 105, altitude: 520 },
    { enhanced_altitude: 130, altitude: 530 },
  ]), 50);
  assert.equal(resolveAscent({}, [], [
    { altitude: 100 }, { altitude: 80 }, { altitude: 95 }, { altitude: 92 }, { altitude: 110 },
  ]), 33);
  assert.equal(resolveAscent({}, [], [{ altitude: 100 }, { altitude: Number.NaN }, { altitude: 90 }]), null);
  assert.equal(resolveAscent({}, [], [{ enhanced_altitude: 10, altitude: 10 }, { altitude: 30 }]), null, 'enhanced and standard altitude are never mixed');
});

test('summarize falls back to top-level laps in list mode output', () => {
  const summary = summarize({
    sessions: [
      {
        sport: 'running',
        start_time: new Date('2026-02-03T07:30:00Z'),
        timestamp: new Date('2026-02-03T08:10:00Z'),
      },
    ],
    laps: [makeLap(), makeLap({ message_index: 1, total_elapsed_time: 300 })],
  });

  assert.equal(summary.laps.length, 2);
  assert.equal(summary.laps[0].durationLabel, '10:00');
  assert.equal(summary.laps[0].cumulativeLabel, '10:00');
  assert.equal(summary.laps[1].cumulativeLabel, '15:00');
});

test('summarize prefers nested session laps over top-level duplicates', () => {
  const summary = summarize({
    sessions: [{ sport: 'running', laps: [makeLap({ total_elapsed_time: 42 })] }],
    laps: [makeLap({ total_elapsed_time: 9999 })],
  });
  assert.equal(summary.laps.length, 1);
  assert.equal(summary.laps[0].durationLabel, '00:42');
});

class StubFitParser {
  constructor(options) {
    this.options = options;
    StubFitParser.lastInstance = this;
  }

  parse(buffer, callback) {
    this.buffer = buffer;
    if (this.error !== undefined) {
      callback(this.error, this.data);
    } else {
      callback(null, this.data);
    }
  }
}

test('parseFitFile resolves a summarized view through the injected parser', async () => {
  const fixture = { sessions: [makeSession([makeLap()])] };
  StubFitParser.prototype.data = fixture;

  const summary = await parseFitFile(Buffer.from('fit-bytes'), {
    FitParser: StubFitParser,
    options: { force: true },
  });

  assert.deepEqual(summary, summarize(fixture));
  assert.ok(StubFitParser.lastInstance.buffer.equals(Buffer.from('fit-bytes')));
  assert.deepEqual(StubFitParser.lastInstance.options, { force: true });
});

test('parseFitFile applies default options when none are provided', async () => {
  const fixture = { sessions: [makeSession([makeLap()])] };
  StubFitParser.prototype.data = fixture;

  await parseFitFile(Buffer.from('fit-bytes'), { FitParser: StubFitParser });

  assert.deepEqual(StubFitParser.lastInstance.options, {
    force: false,
    speedUnit: 'km/h',
    lengthUnit: 'm',
    mode: 'list',
  });
});

test('parseFitFile rejects with Error instances untouched', async () => {
  StubFitParser.prototype.error = new Error('corrupt fit');

  await assert.rejects(
    parseFitFile(Buffer.from('x'), { FitParser: StubFitParser }),
    /corrupt fit/,
  );
});

test('parseFitFile wraps non-Error failures as Error objects', async () => {
  StubFitParser.prototype.error = 'boom';

  await assert.rejects(
    parseFitFile(Buffer.from('x'), { FitParser: StubFitParser }),
    (error) => error instanceof Error && error.message === 'boom',
  );
});

test('parseFitFile rejects when the file has no lap records', async () => {
  StubFitParser.prototype.error = undefined;
  StubFitParser.prototype.data = {};

  await assert.rejects(
    parseFitFile(Buffer.from('x'), { FitParser: StubFitParser }),
    /No lap records found/,
  );
});

test('parseFitFile rejects when the parser never calls back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class SilentParser {
    parse() {}
  }

  const pending = assert.rejects(
    parseFitFile(Buffer.from('x'), { FitParser: SilentParser, timeoutMs: 50 }),
    /Timed out/,
  );
  t.mock.timers.tick(50);
  await pending;
});

const { buildFitFile } = require('./helpers/buildFitFile');

test('parseFitFile decodes a synthetic binary Garmin-style FIT file', async () => {
  const summary = await parseFitFile(buildFitFile());

  assert.deepEqual(summary.activity, {
    sport: 'running',
    startTime: '2026-02-03T07:30:00.000Z',
    endTime: '2026-02-03T08:10:00.000Z',
  });
  assert.equal(summary.laps.length, 2);

  const [runLap, restLap] = summary.laps;
  assert.equal(runLap.stepType, 'Run');
  assert.equal(runLap.durationLabel, '10:00');
  assert.equal(runLap.cumulativeLabel, '10:00');
  assert.equal(runLap.distanceLabel, '2.00');
  assert.equal(runLap.avgPaceLabel, '5:00');
  assert.equal(runLap.bestPaceLabel, '2:30');
  assert.equal(runLap.avgHeartRate, 150);
  assert.equal(runLap.maxHeartRate, 162);
  assert.equal(runLap.avgCadenceSpm, 88);
  assert.equal(runLap.maxCadenceSpm, 92);
  assert.equal(runLap.ascentMeters, 12);
  assert.equal(runLap.calories, 60);

  assert.equal(restLap.stepType, 'Rest');
  assert.equal(restLap.durationLabel, '20:00');
  assert.equal(restLap.cumulativeLabel, '30:00');
  assert.equal(restLap.bestPaceLabel, '3:00');

  assert.deepEqual(summary.totals, {
    durationSeconds: 1800.4,
    durationLabel: '30:00',
    distanceKm: 5,
    distanceLabel: '5.00',
    avgPaceSecondsPerKm: 360.1,
    avgPaceLabel: '6:00',
    avgHeartRate: 150,
    maxHeartRate: 162,
    ascentMeters: 17,
    calories: null,
  });
});

test('parseFitFile integrates with the real fit-file-parser on garbage input', async () => {
  const emptyFitFile = Buffer.from([
    14, 16, 32, 0, 0, 0, 0, 0, 46, 70, 73, 84, 98, 239, 0, 0,
  ]);
  await assert.rejects(parseFitFile(Buffer.alloc(16, 0)), /header/i);
  await assert.rejects(parseFitFile(emptyFitFile), /No lap records found/);
});
