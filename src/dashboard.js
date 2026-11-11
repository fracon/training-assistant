'use strict';
const { userToday } = require('./time-zone');
const { appliedPlanIsCurrent } = require('./ai/context');
const { rpeIssue } = require('./ai/cycle-plan-schema');

const PENDING_WINDOW_DAYS = 14;
const SHOE_LIMIT_SHARE = 0.9;

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// First day of the week holding `iso`, following the account preference.
function weekStart(iso, firstDay) {
  const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay();
  const offset = firstDay === 'Sunday' ? weekday : (weekday + 6) % 7;
  return addDays(iso, -offset);
}

const trainingHref = (id) => `/training-result.html?id=${encodeURIComponent(id)}`;

// The account's next planned session, with the shoe to use and whether its
// workout is scheduled in the connected watch account. A schedule there is not
// proof of delivery to the device, so it is reported as "scheduled" only.
function nextWorkout(db, userId, today, shoes) {
  const row = db.prepare(`SELECT id, dia, periodo, tipo, treino, detalhes, rpe, location, tenis
    FROM trainings WHERE user_id = ? AND completed = 0 AND dia >= ? ORDER BY dia, id LIMIT 1`).get(userId, today);
  if (!row) return null;
  const operation = db.prepare(`SELECT status, scheduled_date, prescription_revision FROM garmin_training_operations
    WHERE user_id = ? AND training_id = ? ORDER BY rowid DESC LIMIT 1`).get(userId, row.id);
  const prescription = db.prepare('SELECT revision FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(userId, row.id);
  const scheduled = operation?.status === 'scheduled' && operation.scheduled_date === row.dia &&
    (!prescription || prescription.revision === operation.prescription_revision);
  const planned = typeof row.tenis === 'string' && row.tenis.trim() ? row.tenis.trim() : null;
  const pair = (shoe, source) => ({ name: `${shoe.brand} ${shoe.model}`.trim(), brand: shoe.brand, model: shoe.model, source });
  // A planned shoe is free text; it gets brand and model when it names an active pair.
  const plannedPair = planned && shoes.find((shoe) => `${shoe.brand} ${shoe.model}`.trim().toLowerCase() === planned.toLowerCase());
  const leastUsed = shoes[0];
  return {
    id: row.id,
    date: row.dia,
    period: row.periodo,
    type: row.tipo,
    name: row.treino || row.tipo,
    details: row.detalhes,
    targetRpe: row.rpe,
    location: row.location,
    href: trainingHref(row.id),
    watch: scheduled ? 'scheduled' : null,
    shoe: plannedPair ? pair(plannedPair, 'planned')
      : planned ? { name: planned, brand: null, model: null, source: 'planned' }
        : leastUsed ? pair(leastUsed, 'least_used') : null,
  };
}

// State of the active cycle's applied plan: whether the AI can still use it
// (current), it must be regenerated (outdated/incompatible) or there is none.
function planState(db, userId) {
  const cycle = db.prepare("SELECT id FROM training_cycles WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(userId);
  if (!cycle) return null;
  const applied = db.prepare('SELECT plan_json, sources_json FROM cycle_plan_versions WHERE user_id = ? AND cycle_id = ? ORDER BY version DESC LIMIT 1').get(userId, cycle.id);
  if (!applied) return 'none';
  if (rpeIssue(JSON.parse(applied.plan_json))) return 'incompatible';
  return appliedPlanIsCurrent(db, userId, cycle.id, applied.sources_json) ? 'current' : 'outdated';
}

// What needs the athlete now, most urgent first. The page shows the first few.
function pending(db, userId, today, plan, shoes) {
  const items = [];
  const from = addDays(today, -PENDING_WINDOW_DAYS);
  // A recorded result without a valid effort stays open on purpose (an imported
  // Garmin activity, for one): it needs the effort, not another result.
  const results = db.prepare(`SELECT id FROM trainings WHERE user_id = ? AND dia >= ? AND dia < ? AND completed = 0
    AND result_data_source = 'none' ORDER BY dia DESC, id DESC`).all(userId, from, today).map((row) => row.id);
  if (results.length) items.push({ key: 'results', count: results.length, href: trainingHref(results[0]) });
  const effort = db.prepare(`SELECT id FROM trainings WHERE user_id = ? AND dia >= ? AND dia <= ?
    AND (completed = 1 OR result_data_source <> 'none') AND (feedback_rpe IS NULL OR feedback_rpe NOT BETWEEN 1 AND 5)
    ORDER BY dia DESC, id DESC`).all(userId, from, today).map((row) => row.id);
  if (effort.length) items.push({ key: 'effort', count: effort.length, href: trainingHref(effort[0]) });
  const latest = db.prepare(`SELECT e.state, p.week_start, p.applied_at FROM ai_executions e
    LEFT JOIN weekly_workout_proposals p ON p.execution_id = e.id AND p.user_id = e.user_id
    WHERE e.user_id = ? AND e.purpose = 'workouts' ORDER BY e.created_at DESC, e.id LIMIT 1`).get(userId);
  if (latest?.state === 'completed' && latest.week_start && !latest.applied_at && latest.week_start >= weekStart(today, 'Monday'))
    items.push({ key: 'proposal', weekStart: latest.week_start, href: '/ai-coach.html' });
  if (plan === 'outdated' || plan === 'incompatible') items.push({ key: 'plan', state: plan, href: '/cycles.html' });
  const hypotheses = db.prepare("SELECT COUNT(*) AS n FROM ai_interpretations WHERE user_id = ? AND disposition = 'pending'").get(userId).n;
  if (hypotheses) items.push({ key: 'hypotheses', count: hypotheses, href: '/training-memory.html' });
  const worn = shoes.filter((shoe) => shoe.target_mileage > 0 && shoe.mileage / shoe.target_mileage >= SHOE_LIMIT_SHARE)
    .sort((a, b) => b.mileage / b.target_mileage - a.mileage / a.target_mileage)[0];
  if (worn) items.push({ key: 'shoe', name: `${worn.brand} ${worn.model}`.trim(), percent: Math.round((worn.mileage / worn.target_mileage) * 100), href: '/shoes.html' });
  return items;
}

// What the dashboard's next-workout and pending cards need, read for one
// account in one transaction, on the account's civil date.
function dashboardSummary(db, userId, today = userToday(db, userId)) {
  return db.transaction(() => {
    const shoes = db.prepare("SELECT brand, model, mileage, target_mileage FROM shoes WHERE user_id = ? AND status = 'active' ORDER BY mileage, id").all(userId);
    return {
      today,
      nextWorkout: nextWorkout(db, userId, today, shoes),
      pending: pending(db, userId, today, planState(db, userId), shoes),
    };
  })();
}

// Completed distance per civil month of `year`, for the monthly volume card.
// Training dates are civil dates already; the account's time zone only decides
// which year and month are current. Kilometres throughout.
function monthlyVolume(db, userId, year, today = userToday(db, userId)) {
  return db.transaction(() => {
    const months = Array(12).fill(0);
    const rows = db.prepare(`SELECT CAST(substr(dia, 6, 2) AS INTEGER) AS month, SUM(fit_distance) AS distance, COUNT(*) AS sessions
      FROM trainings WHERE user_id = ? AND completed = 1 AND fit_distance > 0 AND dia >= ? AND dia <= ?
      GROUP BY month`).all(userId, `${year}-01-01`, `${year}-12-31`);
    let sessions = 0;
    for (const row of rows) { months[row.month - 1] = row.distance; sessions += row.sessions; }
    const first = db.prepare(`SELECT MIN(substr(dia, 1, 4)) AS year FROM trainings
      WHERE user_id = ? AND completed = 1 AND fit_distance > 0`).get(userId).year;
    const currentYear = Number(today.slice(0, 4));
    return {
      year,
      today,
      currentMonth: year === currentYear ? Number(today.slice(5, 7)) : null,
      firstYear: Math.min(first ? Number(first) : currentYear, currentYear),
      lastYear: currentYear,
      months: months.map((distanceKm, index) => ({ month: index + 1, distanceKm })),
      totalKm: months.reduce((total, value) => total + value, 0),
      sessions,
    };
  })();
}

// The year query parameter: absent means the account's current year; anything
// else must be a four-digit year no later than it.
function volumeYear(value, today) {
  const currentYear = Number(today.slice(0, 4));
  if (value === undefined) return currentYear;
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return year >= 1900 && year <= currentYear ? year : null;
}

module.exports = { dashboardSummary, monthlyVolume, volumeYear, weekStart };
