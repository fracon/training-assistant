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
  const trainingId = after?.id ?? before?.id;
  const previous = contribution(before);
  const next = contribution(after);
  const recorded = trainingId == null ? null : db.prepare(
    'SELECT shoe_id AS shoeId, distance FROM training_shoe_mileage WHERE training_id = ? AND user_id = ?'
  ).get(trainingId, userId);

  // A qualifying contribution which predates the ledger is intentionally
  // historical: changing or deleting it must never subtract distance that this
  // system cannot prove it added. A later detach/reattach begins new accounting.
  if (!recorded && previous) return;

  const deltas = new Map();
  if (recorded) deltas.set(recorded.shoeId, -recorded.distance);
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

  if (recorded && !next) {
    db.prepare('DELETE FROM training_shoe_mileage WHERE training_id = ? AND user_id = ?')
      .run(trainingId, userId);
  } else if (next) {
    db.prepare(`INSERT INTO training_shoe_mileage (training_id, user_id, shoe_id, distance)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(training_id) DO UPDATE SET shoe_id = excluded.shoe_id,
        distance = excluded.distance, updated_at = datetime('now')`)
      .run(trainingId, userId, next.shoeId, next.distance);
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

function resolveOwnedShoeLabel(db, userId, label) {
  if (label === null || (typeof label === 'string' && label.trim() === '')) return null;
  if (typeof label !== 'string') throw new ShoeMileageError('feedback_shoe must be a string.');
  const matches = db.prepare(
    `SELECT id, brand, model FROM shoes
      WHERE user_id = ? AND TRIM(brand || ' ' || model) = TRIM(?)`
  ).all(userId, label);
  if (matches.length !== 1) {
    throw new ShoeMileageError('feedback_shoe must identify exactly one owned shoe.');
  }
  return matches[0];
}

module.exports = { ShoeMileageError, contribution, reconcileShoeMileage, resolveOwnedShoe, resolveOwnedShoeLabel };
