'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateMarkdown, escapeCell, formatMetric } = require('../src/markdownGenerator');

function makeLapView(overrides = {}) {
  return {
    stepType: 'Run',
    lap: 1,
    duration: 600.4,
    durationLabel: '10:00',
    cumulativeSeconds: 600.4,
    cumulativeLabel: '10:00',
    distanceKm: 2.0,
    distanceLabel: '2.00',
    avgPaceSecondsPerKm: 300.2,
    avgPaceLabel: '5:00',
    bestPaceSecondsPerKm: 150,
    bestPaceLabel: '2:30',
    avgHeartRate: 150,
    maxHeartRate: 162,
    ascentMeters: 10,
    descentMeters: 4,
    avgCadenceSpm: 88,
    maxCadenceSpm: 92,
    strideMeters: 1.1,
    calories: 60,
    ...overrides,
  };
}

test('escapeCell neutralizes pipes and line breaks', () => {
  assert.equal(escapeCell('felt | strong'), 'felt \\| strong');
  assert.equal(escapeCell('line1\nline2\r\nline3'), 'line1 line2 line3');
});

test('formatMetric renders nullish values as dashes', () => {
  assert.equal(formatMetric(null), '-');
  assert.equal(formatMetric(undefined), '-');
  assert.equal(formatMetric(88), '88');
  assert.equal(formatMetric(1.12), '1.12');
});

test('generateMarkdown renders the full AI coach prompt', () => {
  const summary = {
    activity: {
      sport: 'running',
      startTime: '2026-02-03T07:30:00.000Z',
      endTime: '2026-02-03T08:10:00.000Z',
    },
    laps: [
      makeLapView(),
      makeLapView({
        stepType: 'Rest',
        lap: 2,
        durationLabel: '2:00',
        cumulativeLabel: '12:00',
        distanceKm: 0,
        distanceLabel: '0.00',
        avgPaceSecondsPerKm: null,
        avgPaceLabel: '--:--',
        bestPaceSecondsPerKm: null,
        bestPaceLabel: '--:--',
        avgHeartRate: null,
        maxHeartRate: null,
        ascentMeters: null,
        descentMeters: null,
      }),
    ],
  };

  const markdown = generateMarkdown(summary, {
    rpe: 8,
    notes: 'pernas pesadas | calor\nhidratei bem',
  });

  const expectedRows = [
    '| Run | 1 | 10:00 | 10:00 | 2.00 | 5:00 | 2:30 | 150 | 162 | 10 | 4 | 88 | 92 | 1.1 | 60 |',
    '| Rest | 2 | 2:00 | 12:00 | 0.00 | --:-- | --:-- | - | - | - | - | 88 | 92 | 1.1 | 60 |',
  ].join('\n');

  assert.ok(markdown.startsWith('# AI Coach Review Request'));
  assert.ok(markdown.includes('- **Activity Type:** running'));
  assert.ok(markdown.includes('- **Start Time:** 2026-02-03T07:30:00.000Z'));
  assert.ok(markdown.includes('- **End Time:** 2026-02-03T08:10:00.000Z'));
  assert.ok(markdown.includes(expectedRows));
  assert.ok(markdown.includes('- **RPE:** 8/10'));
  assert.ok(markdown.includes('- **Notes:** pernas pesadas \\| calor hidratei bem'));
  const lines = markdown.split('\n');
  assert.equal(
    lines[lines.length - 2],
    'Ground every recommendation in the table metrics: paces in min/km, heart rate in bpm, cadence in steps per minute, elevation in meters, energy in kcal.',
  );
  assert.equal(lines[lines.length - 1], '');
});

test('generateMarkdown falls back when laps are missing', () => {
  const markdown = generateMarkdown({ activity: {}, laps: [] });
  assert.ok(markdown.includes('_No laps detected in this file._'));
  assert.ok(!markdown.includes('| Step | Lap |'));
});

test('generateMarkdown informs missing feedback and unknown activity fields', () => {
  const markdown = generateMarkdown(
    { activity: { sport: null, startTime: null, endTime: null }, laps: [makeLapView()] },
  );

  assert.ok(markdown.includes('- **Activity Type:** unknown'));
  assert.ok(markdown.includes('- **Start Time:** not recorded'));
  assert.ok(markdown.includes('- **End Time:** not recorded'));
  assert.ok(markdown.includes('- **RPE:** not informed'));
  assert.ok(markdown.includes('- **Notes:** not informed'));
});
