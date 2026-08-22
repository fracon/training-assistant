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
  assert.equal(formatPace(299.7), '5:00');
});

test('formatDistance renders km labels', () => {
  assert.equal(formatDistance(null), '-');
  assert.equal(formatDistance(0), '0.00');
  assert.equal(formatDistance(1.2344), '1.23');
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
      ]),
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
});

test('summarize tolerates missing fields and falls back gracefully', () => {
  const emptySummary = summarize(undefined);
  assert.equal(emptySummary.activity.sport, null);
  assert.equal(emptySummary.activity.startTime, null);
  assert.equal(emptySummary.activity.endTime, null);
  assert.deepEqual(emptySummary.laps, []);

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
});

test('parseFitFile integrates with the real fit-file-parser on garbage input', async () => {
  const emptyFitFile = Buffer.from([
    14, 16, 32, 0, 0, 0, 0, 0, 46, 70, 73, 84, 98, 239, 0, 0,
  ]);
  await assert.rejects(parseFitFile(Buffer.alloc(16, 0)), /header/i);
  await assert.rejects(parseFitFile(emptyFitFile), /No lap records found/);
});
