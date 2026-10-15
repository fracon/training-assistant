'use strict';
const { buildContext } = require('./context');
const { readMemory } = require('./memory');

// Product projection of the SAME bounded selection used for model context.
// No payload, hashes, configuration or prompt is part of this response.
function memoryOverview(db, userId, config, asOf) {
  return db.transaction(() => {
    const context = buildContext(db, userId, { purpose: 'cycle', config, asOf });
    const profile = readMemory(db, userId).profile;
    const stored = db.prepare('SELECT fields_json FROM ai_profiles WHERE user_id = ?').get(userId);
    const legacyAvailable = Boolean(
      (stored && Object.keys(JSON.parse(stored.fields_json)).some((key) => key !== 'experience')) ||
      db.prepare('SELECT 1 FROM ai_memory WHERE user_id = ? LIMIT 1').get(userId),
    );
    const session = (row) => ({
      date: row.date,
      planned: row.planned,
      actual: row.actual,
      report: row.report,
      includedInAggregates: row.includedInAggregates === true,
      href: `/training-result.html?id=${encodeURIComponent(row.source.id)}`,
    });
    return {
      asOf: context.asOf,
      profile,
      legacyAvailable,
      ranges: context.ranges,
      cycle: context.cycle && {
        objective: context.cycle.objective,
        status: context.cycle.status,
        primaryGoal: context.cycle.primary_goal,
        secondaryGoal: context.cycle.secondary_goal,
        otherEvents: context.cycle.other_events,
        targetDate: context.cycle.target_date,
        startDate: context.cycle.start_date,
        updatedAt: context.cycle.updated_at,
        href: '/cycles.html',
      },
      availability: context.availability.map((row) => ({
        day: row.day_key, canTrain: row.can_train === 1,
        periods: JSON.parse(row.available_periods), minutes: row.available_minutes,
        location: row.location, updatedAt: row.updated_at,
      })),
      recent: context.recent.map(session),
      upcoming: context.upcoming.map(session),
      weekly: context.weekly.map((row) => ({
        weekStart: row.weekStart, planned: row.planned, completed: row.completed,
        distanceKm: row.distanceKm, durationSeconds: row.durationSeconds,
        missingResults: row.missingResults, averageRpe: row.averageRpe,
        href: `/calendar.html`,
      })),
      comparables: context.comparables.map(session),
      selectionLimited: context.omissions.length > 0,
    };
  })();
}
module.exports = { memoryOverview };
