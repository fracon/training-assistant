'use strict';

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const PERIOD_KEYS = ['before_08', '08_12', '12_14', '14_18', 'after_18'];
const MAX_AVAILABLE_MINUTES = 720;

function normalizeAvailabilityWeek(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 1 || !Array.isArray(payload.days) || payload.days.length !== 7) {
    return { valid: false, error: 'availability_invalid_week' };
  }
  const byDay = new Map();
  for (const record of payload.days) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        !DAY_KEYS.includes(record.day) || byDay.has(record.day) ||
        typeof record.can_train !== 'boolean') {
      return { valid: false, error: 'availability_invalid_day' };
    }
    if (!record.can_train) {
      byDay.set(record.day, { day: record.day, can_train: false, available_periods: [], available_minutes: null, location: '' });
      continue;
    }
    if (!Array.isArray(record.available_periods) || record.available_periods.length === 0 ||
        record.available_periods.some((period) => !PERIOD_KEYS.includes(period))) {
      return { valid: false, error: 'availability_invalid_periods' };
    }
    const periods = [...new Set(record.available_periods)];
    const minutes = record.available_minutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_AVAILABLE_MINUTES) {
      return { valid: false, error: 'availability_invalid_duration' };
    }
    if (typeof record.location !== 'string' || record.location.trim() === '' || record.location.trim().length > 200) {
      return { valid: false, error: 'availability_invalid_location' };
    }
    byDay.set(record.day, {
      day: record.day,
      can_train: true,
      available_periods: periods,
      available_minutes: minutes,
      location: record.location.trim(),
    });
  }
  return { valid: true, days: DAY_KEYS.map((day) => byDay.get(day)) };
}

function getAvailabilityWeek(db, userId) {
  const rows = db.prepare(
    'SELECT day_key, can_train, available_periods, available_minutes, location FROM ai_coach_availability WHERE user_id = ?'
  ).all(userId);
  const byDay = new Map(rows.map((row) => [row.day_key, row]));
  return {
    days: DAY_KEYS.map((day) => {
      const row = byDay.get(day);
      return row ? {
        day,
        can_train: Boolean(row.can_train),
        available_periods: JSON.parse(row.available_periods),
        available_minutes: row.available_minutes,
        location: row.location,
      } : { day, can_train: null, available_periods: [], available_minutes: null, location: '' };
    }),
    needsReview: rows.length !== DAY_KEYS.length,
  };
}

function saveAvailabilityWeek(db, userId, days) {
  const save = db.transaction(() => {
    const upsert = db.prepare(`INSERT INTO ai_coach_availability
      (user_id, day_key, can_train, available_periods, available_minutes, location, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, day_key) DO UPDATE SET
        can_train = excluded.can_train,
        available_periods = excluded.available_periods,
        available_minutes = excluded.available_minutes,
        location = excluded.location,
        updated_at = datetime('now')`);
    for (const day of days) {
      upsert.run(userId, day.day, day.can_train ? 1 : 0, JSON.stringify(day.available_periods), day.available_minutes, day.location);
    }
  });
  save();
  return getAvailabilityWeek(db, userId);
}

module.exports = { DAY_KEYS, PERIOD_KEYS, MAX_AVAILABLE_MINUTES, normalizeAvailabilityWeek, getAvailabilityWeek, saveAvailabilityWeek };
