'use strict';

const ALLOWED_SOURCES = new Set(['none', 'fit_upload', 'manual', 'garmin_connect']);

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function calculateMetricPace(durationSeconds, distanceKm) {
  const roundedSeconds = Math.round(durationSeconds / distanceKm);
  return `${Math.floor(roundedSeconds / 60)}:${String(roundedSeconds % 60).padStart(2, '0')}`;
}

function optionalInteger(value, field, { positive = false } = {}) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (!Number.isInteger(value) || (positive ? value <= 0 : value < 0)) {
    return { ok: false, error: `${field} must be a ${positive ? 'positive' : 'non-negative'} integer.` };
  }
  return { ok: true, value };
}

function optionalNumber(value, field) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${field} must be a non-negative finite number.` };
  }
  return { ok: true, value };
}

function normalizeManualResults(body = {}) {
  const allowed = new Set([
    'distance_km', 'duration_seconds', 'avg_hr', 'max_hr', 'elevation_gain_m',
    'calories', 'confirm_replace_fit',
  ]);
  const unexpected = Object.keys(body).find((key) => !allowed.has(key));
  if (unexpected) return { ok: false, error: `Unexpected field: ${unexpected}.` };
  if (typeof body.distance_km !== 'number' || !Number.isFinite(body.distance_km) || body.distance_km <= 0) {
    return { ok: false, error: 'distance_km must be a positive finite number.' };
  }
  if (!Number.isInteger(body.duration_seconds) || body.duration_seconds <= 0) {
    return { ok: false, error: 'duration_seconds must be a positive integer.' };
  }
  if (body.confirm_replace_fit !== undefined && typeof body.confirm_replace_fit !== 'boolean') {
    return { ok: false, error: 'confirm_replace_fit must be a boolean.' };
  }
  const avg = optionalInteger(body.avg_hr, 'avg_hr', { positive: true });
  const max = optionalInteger(body.max_hr, 'max_hr', { positive: true });
  const elevation = optionalNumber(body.elevation_gain_m, 'elevation_gain_m');
  const calories = optionalInteger(body.calories, 'calories');
  for (const result of [avg, max, elevation, calories]) if (!result.ok) return result;
  if (avg.value !== null && max.value !== null && max.value < avg.value) {
    return { ok: false, error: 'max_hr cannot be lower than avg_hr.' };
  }
  return {
    ok: true,
    value: {
      distance_km: body.distance_km,
      duration_seconds: body.duration_seconds,
      avg_hr: avg.value,
      max_hr: max.value,
      elevation_gain_m: elevation.value,
      calories: calories.value,
      confirm_replace_fit: body.confirm_replace_fit === true,
      fit_duration: formatDuration(body.duration_seconds),
      fit_avg_pace: calculateMetricPace(body.duration_seconds, body.distance_km),
    },
  };
}

function isResultSource(value) {
  return ALLOWED_SOURCES.has(value);
}

module.exports = { formatDuration, calculateMetricPace, normalizeManualResults, isResultSource };
