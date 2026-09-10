'use strict';

class ShoeMileageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ShoeMileageError';
    this.status = status;
  }
}

function contribution(training) {
  const distance = Number(training?.fit_distance);
  return training?.completed === 1 && training?.feedback_shoe_id &&
    Number.isFinite(distance) && distance > 0
    ? { shoeId: training.feedback_shoe_id, distance }
    : null;
}

function reconcileShoeMileage(db, userId, before, after) {
  const previous = contribution(before);
  const next = contribution(after);
  const deltas = new Map();
  if (previous) deltas.set(previous.shoeId, -previous.distance);
  if (next) deltas.set(next.shoeId, (deltas.get(next.shoeId) || 0) + next.distance);

  const update = db.prepare(
    `UPDATE shoes
       SET mileage = MAX(0, mileage + ?), updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  );
  for (const [shoeId, delta] of deltas) {
    if (delta !== 0 && update.run(delta, shoeId, userId).changes !== 1) {
      throw new ShoeMileageError('Selected shoe does not belong to the authenticated user.');
    }
  }
}

function resolveOwnedShoe(db, userId, shoeId) {
  if (shoeId === null || shoeId === '') return null;
  if (typeof shoeId !== 'string') {
    throw new ShoeMileageError('feedback_shoe_id must be a string or null.');
  }
  const shoe = db.prepare(
    'SELECT id, brand, model FROM shoes WHERE id = ? AND user_id = ?'
  ).get(shoeId, userId);
  if (!shoe) {
    throw new ShoeMileageError('Selected shoe does not belong to the authenticated user.');
  }
  return shoe;
}

module.exports = { ShoeMileageError, contribution, reconcileShoeMileage, resolveOwnedShoe };
