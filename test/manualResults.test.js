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
  assert.deepEqual(result, { ok: true, value: { distance_km: 10.25, duration_seconds: 3725, avg_hr: null, max_hr: null, elevation_gain_m: 104, calories: 742, confirm_replace_fit: false, fit_duration: '1:02:05', fit_avg_pace: '6:03' } });
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
