'use strict';

const crypto = require('node:crypto');

const VALID_STATUSES = ['active', 'retired'];
const DEFAULT_STATUS = 'active';
const DEFAULT_MILEAGE = 0.0;

class ShoeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ShoeError';
    this.status = status;
  }
}

function normalizeShoeInput(body) {
  const brand = typeof body?.brand === 'string' ? body.brand.trim() : '';
  const model = typeof body?.model === 'string' ? body.model.trim() : '';

  let mileage = body?.mileage;
  if (mileage === undefined || mileage === null || mileage === '') {
    mileage = DEFAULT_MILEAGE;
  } else {
    mileage = Number(mileage);
  }

  let targetMileage = body?.target_mileage;
  if (targetMileage === undefined || targetMileage === null || targetMileage === '') {
    targetMileage = null;
  } else {
    targetMileage = Number(targetMileage);
  }

  const status = typeof body?.status === 'string' && body.status.trim() !== ''
    ? body.status.trim().toLowerCase()
    : DEFAULT_STATUS;

  return { brand, model, mileage, target_mileage: targetMileage, status };
}

function validateShoe({ brand, model, mileage, target_mileage, status }) {
  const errors = [];

  if (!brand) {
    errors.push('brand is required.');
  }
  if (!model) {
    errors.push('model is required.');
  }
  if (typeof mileage !== 'number' || Number.isNaN(mileage) || mileage < 0) {
    errors.push('mileage must be a non-negative number.');
  }
  if (target_mileage !== null && (typeof target_mileage !== 'number' || Number.isNaN(target_mileage) || target_mileage < 0)) {
    errors.push('target_mileage must be null or a non-negative number.');
  }
  if (!VALID_STATUSES.includes(status)) {
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
  }

  if (errors.length > 0) {
    throw new ShoeError(errors.join(' '), 400);
  }
}

function createShoe(db, userId, body) {
  const input = normalizeShoeInput(body);
  validateShoe(input);

  const id = crypto.randomUUID();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(
    `INSERT INTO shoes (id, user_id, brand, model, mileage, target_mileage, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(id, userId, input.brand, input.model, input.mileage, input.target_mileage, input.status);

  return db.prepare('SELECT * FROM shoes WHERE id = ?').get(id);
}

function getShoesByUserId(db, userId) {
  return db.prepare(
    'SELECT * FROM shoes WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

function getShoeById(db, id, userId) {
  return db.prepare('SELECT * FROM shoes WHERE id = ? AND user_id = ?').get(id, userId);
}

function updateShoe(db, id, userId, updates) {
  const existing = getShoeById(db, id, userId);
  if (!existing) {
    return null;
  }

  const fields = {};
  if (updates.brand !== undefined) {
    const brand = typeof updates.brand === 'string' ? updates.brand.trim() : '';
    if (!brand) throw new ShoeError('brand is required.', 400);
    fields.brand = brand;
  }
  if (updates.model !== undefined) {
    const model = typeof updates.model === 'string' ? updates.model.trim() : '';
    if (!model) throw new ShoeError('model is required.', 400);
    fields.model = model;
  }
  if (updates.mileage !== undefined) {
    const mileage = Number(updates.mileage);
    if (typeof mileage !== 'number' || Number.isNaN(mileage) || mileage < 0) {
      throw new ShoeError('mileage must be a non-negative number.', 400);
    }
    fields.mileage = mileage;
  }
  if (updates.target_mileage !== undefined) {
    if (updates.target_mileage === null || updates.target_mileage === '') {
      fields.target_mileage = null;
    } else {
      const target = Number(updates.target_mileage);
      if (typeof target !== 'number' || Number.isNaN(target) || target < 0) {
        throw new ShoeError('target_mileage must be null or a non-negative number.', 400);
      }
      fields.target_mileage = target;
    }
  }
  if (updates.status !== undefined) {
    const status = typeof updates.status === 'string' ? updates.status.trim().toLowerCase() : '';
    if (!VALID_STATUSES.includes(status)) {
      throw new ShoeError(`status must be one of: ${VALID_STATUSES.join(', ')}.`, 400);
    }
    fields.status = status;
  }

  const keys = Object.keys(fields);
  if (keys.length === 0) {
    return existing;
  }

  const assignments = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(
    `UPDATE shoes SET ${assignments}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
  ).run(...keys.map((k) => fields[k]), id, userId);

  return getShoeById(db, id, userId);
}

function deleteShoe(db, id, userId) {
  const existing = getShoeById(db, id, userId);
  if (!existing) {
    return false;
  }
  db.prepare('DELETE FROM shoes WHERE id = ? AND user_id = ?').run(id, userId);
  return true;
}

module.exports = {
  VALID_STATUSES,
  DEFAULT_STATUS,
  DEFAULT_MILEAGE,
  ShoeError,
  normalizeShoeInput,
  validateShoe,
  createShoe,
  getShoesByUserId,
  getShoeById,
  updateShoe,
  deleteShoe,
};
