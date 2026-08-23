'use strict';

const SUPPORTED_WEEK_STARTS = ['Monday', 'Sunday'];
const DEFAULT_WEEK_START = 'Monday';

function normalizeWeekStart(value) {
  if (typeof value !== 'string') {
    return DEFAULT_WEEK_START;
  }
  const candidate = value.trim();
  const match = SUPPORTED_WEEK_STARTS.find(
    (day) => day.toLowerCase() === candidate.toLowerCase()
  );
  return match ?? DEFAULT_WEEK_START;
}

function isSupportedWeekStart(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const candidate = value.trim().toLowerCase();
  return SUPPORTED_WEEK_STARTS.some((day) => day.toLowerCase() === candidate);
}

module.exports = {
  SUPPORTED_WEEK_STARTS,
  DEFAULT_WEEK_START,
  normalizeWeekStart,
  isSupportedWeekStart,
};
