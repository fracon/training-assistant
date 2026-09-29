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
  assert.deepEqual(result, { ok: true, value: { distance_km: 10.25, duration_seconds: 3725, avg_hr: null, max_hr: null, elevation_gain_m: 104, calories: 742, feedback_rpe: null, feedback_rpe_supplied: false, confirm_replace_fit: false, fit_duration: '1:02:05', fit_avg_pace: '6:03' } });
});

test('normalizeManualResults keeps a supplied realized RPE apart from an omitted one', () => {
  // A manual write always concludes the workout, so this field only answers
  // which effort the conclusion carries. Presence is reported next to the
  // value: only a genuinely omitted field may fall back to the stored effort.
  assert.equal(
    normalizeManualResults({ distance_km: 1, duration_seconds: 60 }).value.feedback_rpe_supplied,
    false,
    'an omitted effort is not a supplied one'
  );
  for (const blank of [null, '']) {
    const cleared = normalizeManualResults({ distance_km: 1, duration_seconds: 60, feedback_rpe: blank });
    assert.equal(cleared.ok, true, `an explicit clear is a conclusion request, not a format error: ${JSON.stringify(blank)}`);
    assert.deepEqual(
      { value: cleared.value.feedback_rpe, supplied: cleared.value.feedback_rpe_supplied },
      { value: null, supplied: true },
      'an explicit clear stays a supplied, unanswered effort'
    );
  }
  for (const reported of [1, 3, 5]) {
    const value = normalizeManualResults({ distance_km: 1, duration_seconds: 60, feedback_rpe: reported }).value;
    assert.deepEqual({ value: value.feedback_rpe, supplied: value.feedback_rpe_supplied }, { value: reported, supplied: true });
  }
  // Anything that is not a reported 1-5 effort carries no effort at all, and the
  // route refuses the conclusion with one stable message instead of a format
  // error that would not describe the missing effort.
  for (const unusable of [0, 6, 2.5, '3', true, {}]) {
    const normalized = normalizeManualResults({ distance_km: 1, duration_seconds: 60, feedback_rpe: unusable });
    assert.equal(normalized.ok, true, `feedback_rpe=${JSON.stringify(unusable)} is judged by the conclusion rule`);
    assert.deepEqual(
      { value: normalized.value.feedback_rpe, supplied: normalized.value.feedback_rpe_supplied },
      { value: null, supplied: true },
      `feedback_rpe=${JSON.stringify(unusable)} is not a reported effort`
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
