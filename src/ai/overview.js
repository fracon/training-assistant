'use strict';
const { buildContext } = require('./context');
const { readMemory, AiError } = require('./memory');
const { userToday } = require('../time-zone');

const PURPOSES = ['cycle', 'workouts', 'analysis'];

function addIsoDays(value, amount) {
  const result = new Date(`${value}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return result.toISOString().slice(0, 10);
}
// The week Request Workouts plans by default: the Monday after today.
function nextMonday(day) {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return addIsoDays(day, ((8 - weekday) % 7) || 7);
}

// A selection rank shown as a badge; never a diagnosis or a restriction.
function priority(report) {
  if (report.feedback_has_pain === 'yes' || (typeof report.feedback_pain === 'string' && report.feedback_pain.trim()))
    return 'concern';
  return Number.isInteger(report.feedback_rpe) && report.feedback_rpe >= 4 ? 'high_effort' : null;
}

// The task each purpose's view reproduces: the active cycle for cycle planning,
// next week for weekly workouts, and an owned completed session for analysis
// (the most recent one unless the athlete picks another).
function taskFor(db, userId, purpose, today, resourceId) {
  if (purpose === 'cycle') {
    const cycle = db.prepare("SELECT id FROM training_cycles WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(userId);
    return { resourceId: cycle ? cycle.id : null };
  }
  if (purpose === 'workouts') return { resourceId: null, taskDate: nextMonday(today) };
  if (resourceId !== null) return { resourceId };
  const latest = db.prepare('SELECT id FROM trainings WHERE user_id = ? AND completed = 1 AND dia <= ? ORDER BY dia DESC, id DESC LIMIT 1').get(userId, today);
  return { resourceId: latest ? latest.id : null };
}

// Product projection of the SAME bounded selection a task of this purpose sends
// to the model. No payload, hashes, configuration or prompt is part of this
// response, and reading it never starts a generation.
function memoryOverview(db, userId, config, asOf = null, { purpose = 'cycle', resourceId = null } = {}) {
  if (!PURPOSES.includes(purpose)) throw new AiError('invalidPurpose');
  return db.transaction(() => {
    const today = asOf ?? userToday(db, userId);
    const task = taskFor(db, userId, purpose, today, resourceId);
    const context = buildContext(db, userId, { purpose, config, asOf: today, ...task });
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
      priority: priority(row.report),
      includedInAggregates: row.includedInAggregates === true,
      href: `/training-result.html?id=${encodeURIComponent(row.source.id)}`,
    });
    const currentInterpretations = new Set((context.interpretations || []).map((item) => item.source.id));
    const interpretations = db.prepare(`SELECT i.id,i.training_id,i.kind,i.text,i.disposition,
      i.correction_text,i.version,i.updated_at,t.dia FROM ai_interpretations i
      JOIN trainings t ON t.id=i.training_id AND t.user_id=i.user_id
      WHERE i.user_id=? ORDER BY i.updated_at DESC,i.id LIMIT 60`).all(userId)
      .map((item) => {
        const current = currentInterpretations.has(item.id);
        return {
          ...item,
          current,
          // Why an item is or is not in this task's context, in product terms.
          inclusion: current ? 'used'
            : item.disposition === 'dismissed' ? 'dismissed'
              : item.disposition === 'superseded' ? 'superseded' : 'not_current',
          originalText: item.text,
          text: item.disposition === 'corrected' ? item.correction_text : item.text,
          href: `/training-result.html?id=${encodeURIComponent(item.training_id)}`,
        };
      });
    const plan = context.appliedPlan;
    const omissions = context.omissionSummary;
    return {
      purpose,
      asOf: context.asOf,
      task: purpose === 'workouts'
        ? { weekStart: context.resource.weekStart }
        : purpose === 'analysis'
          ? { session: context.resource ? session(context.resource) : null }
          : { cycleId: task.resourceId },
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
      appliedPlan: plan ? {
        version: plan.version,
        appliedAt: plan.appliedAt,
        outdated: plan.outdated,
        compatibilityError: plan.compatibilityError ?? null,
        start: plan.start,
        end: plan.end,
        architecture: plan.architecture,
        phases: plan.phases.map(({ name, start, end, objective }) => ({ name, start, end, objective })),
        currentPhase: plan.architecture.find((phase) => phase.start <= context.asOf && phase.end >= context.asOf) ?? null,
        indicators: plan.indicators,
        href: '/cycles.html',
      } : null,
      previousCycles: (context.previousCycles || []).map((row) => ({
        objective: row.objective, status: row.status, targetDate: row.target_date, startDate: row.start_date,
      })),
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
      shoes: context.shoes.map((row) => ({
        brand: row.brand, model: row.model, status: row.status,
        mileage: row.mileage, targetMileage: row.target_mileage, href: '/shoes.html',
      })),
      interpretations,
      omissions: {
        budget: omissions.budget,
        budgetTotal: Object.values(omissions.budget).reduce((sum, count) => sum + count, 0),
        reducedDetails: omissions.reducedDetails,
        historical: omissions.historical,
        phasesOutsideWindow: omissions.phasesOutsideWindow,
        incompatiblePlan: omissions.incompatiblePlan,
      },
    };
  })();
}
module.exports = { memoryOverview, nextMonday };
