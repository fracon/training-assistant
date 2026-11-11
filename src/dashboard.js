'use strict';
const { userToday } = require('./time-zone');
const { contextIsCurrent } = require('./ai/context');
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
  const row = db.prepare(`SELECT id, dia, periodo, tipo, treino, detalhes, rpe, fc_alvo, location, tenis
    FROM trainings WHERE user_id = ? AND completed = 0 AND dia >= ? ORDER BY dia, id LIMIT 1`).get(userId, today);
  if (!row) return null;
  const operation = db.prepare(`SELECT status, scheduled_date, prescription_revision FROM garmin_training_operations
    WHERE user_id = ? AND training_id = ? ORDER BY rowid DESC LIMIT 1`).get(userId, row.id);
  const prescription = db.prepare('SELECT revision FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(userId, row.id);
  const scheduled = operation?.status === 'scheduled' && operation.scheduled_date === row.dia &&
    (!prescription || prescription.revision === operation.prescription_revision);
  const planned = typeof row.tenis === 'string' && row.tenis.trim() ? row.tenis.trim() : null;
  const leastUsed = shoes[0];
  return {
    id: row.id,
    date: row.dia,
    period: row.periodo,
    type: row.tipo,
    name: row.treino || row.tipo,
    details: row.detalhes,
    targetRpe: row.rpe,
    targetHr: row.fc_alvo,
    location: row.location,
    href: trainingHref(row.id),
    watch: scheduled ? 'scheduled' : null,
    shoe: planned ? { name: planned, source: 'planned' }
      : leastUsed ? { name: `${leastUsed.brand} ${leastUsed.model}`.trim(), source: 'least_used' } : null,
  };
}

function lastWorkout(db, userId, today) {
  const row = db.prepare(`SELECT id, dia, tipo, treino, fit_distance, fit_duration, feedback_rpe
    FROM trainings WHERE user_id = ? AND completed = 1 AND dia <= ? ORDER BY dia DESC, id DESC LIMIT 1`).get(userId, today);
  return row ? {
    id: row.id, date: row.dia, name: row.treino || row.tipo, distanceKm: row.fit_distance,
    duration: row.fit_duration, rpe: row.feedback_rpe, href: trainingHref(row.id),
  } : null;
}

function week(db, userId, today, firstDay) {
  const start = weekStart(today, firstDay);
  const totals = (from, to) => db.prepare(`SELECT COUNT(*) AS planned, COALESCE(SUM(completed = 1), 0) AS completed,
    COALESCE(SUM(CASE WHEN completed = 1 THEN fit_distance END), 0) AS distance
    FROM trainings WHERE user_id = ? AND dia >= ? AND dia <= ?`).get(userId, from, to);
  const current = totals(start, addDays(start, 6));
  const previous = totals(addDays(start, -7), addDays(start, -1));
  return { start, planned: current.planned, completed: current.completed, distanceKm: current.distance, previousDistanceKm: previous.distance };
}

// The active cycle's applied plan: its current phase and whether the AI can
// still use it (current), must be regenerated (outdated/incompatible) or is absent.
function cyclePlan(db, userId, today, config) {
  const cycle = db.prepare("SELECT id FROM training_cycles WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(userId);
  if (!cycle) return null;
  const applied = db.prepare('SELECT plan_json, fingerprint_json FROM cycle_plan_versions WHERE user_id = ? AND cycle_id = ? ORDER BY version DESC LIMIT 1').get(userId, cycle.id);
  if (!applied) return { planState: 'none', phase: null };
  const plan = JSON.parse(applied.plan_json);
  const phase = plan.phases.find((item) => item.start <= today && item.end >= today);
  const planState = rpeIssue(plan) ? 'incompatible'
    : contextIsCurrent(db, userId, JSON.parse(applied.fingerprint_json), config) ? 'current' : 'outdated';
  return { planState, phase: phase ? { name: phase.name, objective: phase.objective, start: phase.start, end: phase.end } : null };
}

// What needs the athlete now, most urgent first. The page shows the first few.
function pending(db, userId, today, cycle, shoes) {
  const items = [];
  const from = addDays(today, -PENDING_WINDOW_DAYS);
  const results = db.prepare(`SELECT id FROM trainings WHERE user_id = ? AND dia >= ? AND dia < ? AND completed = 0
    ORDER BY dia DESC, id DESC`).all(userId, from, today).map((row) => row.id);
  if (results.length) items.push({ key: 'results', count: results.length, href: trainingHref(results[0]) });
  const effort = db.prepare(`SELECT id FROM trainings WHERE user_id = ? AND dia >= ? AND dia <= ? AND completed = 1
    AND feedback_rpe IS NULL ORDER BY dia DESC, id DESC`).all(userId, from, today).map((row) => row.id);
  if (effort.length) items.push({ key: 'effort', count: effort.length, href: trainingHref(effort[0]) });
  const latest = db.prepare(`SELECT e.state, p.week_start, p.applied_at FROM ai_executions e
    LEFT JOIN weekly_workout_proposals p ON p.execution_id = e.id AND p.user_id = e.user_id
    WHERE e.user_id = ? AND e.purpose = 'workouts' ORDER BY e.created_at DESC, e.id LIMIT 1`).get(userId);
  if (latest?.state === 'completed' && latest.week_start && !latest.applied_at && latest.week_start >= weekStart(today, 'Monday'))
    items.push({ key: 'proposal', weekStart: latest.week_start, href: '/ai-coach.html' });
  if (cycle && ['outdated', 'incompatible'].includes(cycle.planState))
    items.push({ key: 'plan', state: cycle.planState, href: '/cycles.html' });
  const hypotheses = db.prepare("SELECT COUNT(*) AS n FROM ai_interpretations WHERE user_id = ? AND disposition = 'pending'").get(userId).n;
  if (hypotheses) items.push({ key: 'hypotheses', count: hypotheses, href: '/training-memory.html' });
  const worn = shoes.filter((shoe) => shoe.target_mileage > 0 && shoe.mileage / shoe.target_mileage >= SHOE_LIMIT_SHARE)
    .sort((a, b) => b.mileage / b.target_mileage - a.mileage / a.target_mileage)[0];
  if (worn) items.push({ key: 'shoe', name: `${worn.brand} ${worn.model}`.trim(), percent: Math.round((worn.mileage / worn.target_mileage) * 100), href: '/shoes.html' });
  return items;
}

// Everything the dashboard's next-workout, pending, week and cycle cards need,
// read for one account in one transaction, on the account's civil date.
function dashboardSummary(db, userId, config, today = userToday(db, userId)) {
  return db.transaction(() => {
    const firstDay = db.prepare('SELECT first_day_of_week FROM users WHERE id = ?').get(userId)?.first_day_of_week;
    const shoes = db.prepare("SELECT brand, model, mileage, target_mileage FROM shoes WHERE user_id = ? AND status = 'active' ORDER BY mileage, id").all(userId);
    const cycle = cyclePlan(db, userId, today, config);
    return {
      today,
      nextWorkout: nextWorkout(db, userId, today, shoes),
      lastWorkout: lastWorkout(db, userId, today),
      week: week(db, userId, today, firstDay),
      cycle,
      pending: pending(db, userId, today, cycle, shoes),
    };
  })();
}

module.exports = { dashboardSummary, weekStart };
