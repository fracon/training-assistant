'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDuration, calculateMetricPace, normalizeManualResults, isResultSource } = require('../src/manualResults');

test('manual result helpers format duration and calculate rounded metric pace', () => {
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(calculateMetricPace(3725, 10.25), '6:03');
  assert.equal(calculateMetricPace(5405, 10), '9:01');
});

test('normalizeManualResults accepts canonical metrics and clears blank optionals', () => {
  const result = normalizeManualResults({ distance_km: 10.25, duration_seconds: 3725, avg_hr: '', max_hr: null, elevation_gain_m: 104, calories: 742 });
  assert.deepEqual(result, { ok: true, value: { distance_km: 10.25, duration_seconds: 3725, avg_hr: null, max_hr: null, elevation_gain_m: 104, calories: 742, feedback_rpe: null, confirm_replace_fit: false, fit_duration: '1:02:05', fit_avg_pace: '6:03' } });
});

test('normalizeManualResults carries the realized RPE and refuses values outside 1-5', () => {
  for (const blank of [undefined, null, '']) {
    assert.equal(
      normalizeManualResults({ distance_km: 1, duration_seconds: 60, feedback_rpe: blank }).value.feedback_rpe,
      null,
      `an absent effort stays unanswered for ${JSON.stringify(blank)}`
    );
  }
  for (const reported of [1, 3, 5]) {
    assert.equal(
      normalizeManualResults({ distance_km: 1, duration_seconds: 60, feedback_rpe: reported }).value.feedback_rpe,
      reported
    );
  }
  for (const rejected of [0, 6, 2.5, '3', true]) {
    assert.deepEqual(
      normalizeManualResults({ distance_km: 1, duration_seconds: 60, feedback_rpe: rejected }),
      { ok: false, error: 'feedback_rpe must be an integer between 1 and 5.' },
      `feedback_rpe=${String(rejected)} is not a reported effort`
    );
  }
});

test('normalizeManualResults rejects invalid, conflicting, and unexpected payload values', () => {
  for (const body of [
    { distance_km: 0, duration_seconds: 1 }, { distance_km: 1, duration_seconds: 0 },
    { distance_km: 1, duration_seconds: 60, avg_hr: 0 }, { distance_km: 1, duration_seconds: 60, max_hr: 120, avg_hr: 140 },
    { distance_km: 1, duration_seconds: 60, elevation_gain_m: -1 }, { distance_km: 1, duration_seconds: 60, calories: -1 },
    { distance_km: 1, duration_seconds: 60, user_id: 99 }, { distance_km: 1, duration_seconds: 60, confirm_replace_fit: 'yes' },
  ]) assert.equal(normalizeManualResults(body).ok, false);
  assert.equal(isResultSource('manual'), true);
  assert.equal(isResultSource('garmin_connect'), true);
  assert.equal(isResultSource('unknown'), false);
});
