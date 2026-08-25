'use strict';

const crypto = require('node:crypto');

const VALID_STATUSES = ['active', 'completed', 'cancelled'];
const DEFAULT_STATUS = 'active';

class CycleError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CycleError';
    this.status = status;
  }
}

function normalizeCycleInput(body) {
  const objective = typeof body?.objective === 'string' ? body.objective.trim() : '';
  const target_date = typeof body?.target_date === 'string' ? body.target_date.trim() : null;
  const distance = typeof body?.distance === 'string' ? body.distance.trim() : null;
  const run_before = typeof body?.run_before === 'string' ? body.run_before.trim() : null;
  let run_count = body?.run_count;
  if (run_count === undefined || run_count === null || run_count === '') {
    run_count = null;
  } else {
    run_count = Number(run_count);
  }
  const primary_goal = typeof body?.primary_goal === 'string' ? body.primary_goal.trim() : null;
  const secondary_goal = typeof body?.secondary_goal === 'string' ? body.secondary_goal.trim() : null;
  const start_date = typeof body?.start_date === 'string' ? body.start_date.trim() : null;
  const other_events = typeof body?.other_events === 'string' ? body.other_events.trim() : null;
  const status = typeof body?.status === 'string' && body.status.trim() !== ''
    ? body.status.trim().toLowerCase()
    : DEFAULT_STATUS;
  return {
    objective,
    target_date,
    distance,
    run_before,
    run_count,
    primary_goal,
    secondary_goal,
    start_date,
    other_events,
    status,
  };
}

function validateCycle(input) {
  const errors = [];
  if (!input.objective) errors.push('objective is required.');
  if (!VALID_STATUSES.includes(input.status))
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
  if (input.run_count !== null && (typeof input.run_count !== 'number' || Number.isNaN(input.run_count) || input.run_count < 0))
    errors.push('run_count must be null or a non-negative number.');
  if (errors.length > 0) throw new CycleError(errors.join(' '), 400);
}

function getActiveCycle(db, userId) {
  return db.prepare(
    'SELECT * FROM training_cycles WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
  ).get(userId, 'active');
}

function createCycle(db, userId, body) {
  const input = normalizeCycleInput(body);
  if (input.status === 'active') {
    const existing = getActiveCycle(db, userId);
    if (existing) {
      throw new CycleError('An active cycle already exists. Complete or cancel it first.', 409);
    }
  }
  validateCycle(input);
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO training_cycles (id, user_id, objective, target_date, distance, run_before, run_count, primary_goal, secondary_goal, start_date, other_events, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(id, userId, input.objective, input.target_date, input.distance, input.run_before, input.run_count, input.primary_goal, input.secondary_goal, input.start_date, input.other_events, input.status);
  return db.prepare('SELECT * FROM training_cycles WHERE id = ?').get(id);
}

function getCyclesByUserId(db, userId) {
  return db.prepare('SELECT * FROM training_cycles WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function getCycleById(db, id, userId) {
  return db.prepare('SELECT * FROM training_cycles WHERE id = ? AND user_id = ?').get(id, userId);
}

function updateCycle(db, id, userId, updates) {
  const existing = getCycleById(db, id, userId);
  if (!existing) return null;
  const fields = {};
  const allowed = ['objective', 'target_date', 'distance', 'run_before', 'run_count', 'primary_goal', 'secondary_goal', 'start_date', 'other_events', 'status'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      fields[key] = updates[key];
    }
  }
  if (fields.status !== undefined && !VALID_STATUSES.includes(fields.status)) {
    throw new CycleError(`status must be one of: ${VALID_STATUSES.join(', ')}.`, 400);
  }
  if (fields.status === 'active') {
    const active = getActiveCycle(db, userId);
    if (active && active.id !== id) {
      throw new CycleError('An active cycle already exists. Complete or cancel it first.', 409);
    }
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) return existing;
  const assignments = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE training_cycles SET ${assignments}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(...keys.map((k) => fields[k]), id, userId);
  return getCycleById(db, id, userId);
}

function deleteCycle(db, id, userId) {
  const existing = getCycleById(db, id, userId);
  if (!existing) return false;
  db.prepare('DELETE FROM training_cycles WHERE id = ? AND user_id = ?').run(id, userId);
  return true;
}

module.exports = {
  VALID_STATUSES,
  DEFAULT_STATUS,
  CycleError,
  normalizeCycleInput,
  validateCycle,
  getActiveCycle,
  createCycle,
  getCyclesByUserId,
  getCycleById,
  updateCycle,
  deleteCycle,
};
