'use strict';

// The account's IANA time zone decides which calendar day is "today" for it.
// Unknown or missing zones fall back to UTC, the previous behavior.
const MAX_TIME_ZONE_LENGTH = 64;

function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_TIME_ZONE_LENGTH) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Civil date (YYYY-MM-DD) of `now` in `timeZone`.
function localDate(timeZone, now = new Date()) {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Today for one account, read from its stored zone.
function userToday(db, userId, now = new Date()) {
  const row = db.prepare('SELECT time_zone FROM users WHERE id = ?').get(userId);
  return localDate(row?.time_zone, now);
}

module.exports = { MAX_TIME_ZONE_LENGTH, isValidTimeZone, localDate, userToday };
