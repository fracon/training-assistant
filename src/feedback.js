'use strict';

const FEEDBACK_TYPES = ['bug', 'suggestion', 'other'];
const FEEDBACK_STATUSES = ['new', 'in_progress', 'resolved'];
const FEEDBACK_PATHS = new Set([
  '/home.html', '/training-result.html', '/calendar.html', '/ai-coach.html',
  '/cycles.html', '/shoes.html', '/admin-users.html', '/admin-feedback.html',
]);
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_INTERNAL_NOTE_LENGTH = 5000;

class FeedbackError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'FeedbackError';
    this.status = status;
    this.code = code;
  }
}

function assertObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FeedbackError(400, 'invalidBody', 'A JSON object is required.');
  }
}

function rejectUnknown(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new FeedbackError(400, 'unknownField', `Unsupported field: ${key}.`);
  }
}

function normalizeType(value) {
  if (typeof value !== 'string' || !FEEDBACK_TYPES.includes(value)) {
    throw new FeedbackError(400, 'invalidType', 'Feedback type is invalid.');
  }
  return value;
}

function normalizeStatus(value) {
  if (typeof value !== 'string' || !FEEDBACK_STATUSES.includes(value)) {
    throw new FeedbackError(400, 'invalidStatus', 'Feedback status is invalid.');
  }
  return value;
}

function normalizeDescription(value) {
  if (typeof value !== 'string') throw new FeedbackError(400, 'descriptionRequired', 'Description is required.');
  const description = value.trim();
  if (!description) throw new FeedbackError(400, 'descriptionRequired', 'Description is required.');
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new FeedbackError(400, 'descriptionTooLong', 'Description is too long.');
  }
  return description;
}

function normalizePathname(value) {
  if (typeof value !== 'string' || !FEEDBACK_PATHS.has(value)) {
    throw new FeedbackError(400, 'invalidPathname', 'The source page is invalid.');
  }
  return value;
}

function normalizeInternalNote(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > MAX_INTERNAL_NOTE_LENGTH) {
    throw new FeedbackError(400, 'internalNoteTooLong', 'Internal note is too long.');
  }
  return value.trim();
}

function publicFeedback(row) {
  return {
    id: row.id,
    author_user_id: row.author_user_id ?? null,
    author_email: row.author_email,
    type: row.type,
    description: row.description,
    pathname: row.pathname,
    status: row.status,
    internal_note: row.internal_note ?? '',
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
  };
}

function normalizeId(value) {
  const text = String(value ?? '').trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || number < 1 || !Number.isSafeInteger(number)) {
    throw new FeedbackError(400, 'invalidId', 'Feedback id is invalid.');
  }
  return number;
}

function createFeedback(db, user, body) {
  assertObject(body);
  rejectUnknown(body, ['type', 'description', 'pathname']);
  const type = normalizeType(body.type);
  const description = normalizeDescription(body.description);
  const pathname = normalizePathname(body.pathname);
  const result = db.prepare(`INSERT INTO feedback
    (author_user_id, author_email, type, description, pathname)
    VALUES (?, ?, ?, ?, ?)`).run(user.id, user.email, type, description, pathname);
  return publicFeedback(db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid));
}

function listFeedback(db, filters = {}) {
  const status = filters.status === undefined ? null : normalizeStatus(filters.status);
  const type = filters.type === undefined ? null : normalizeType(filters.type);
  const page = Number.isInteger(filters.page) && filters.page > 0 ? filters.page : 1;
  const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? Math.min(filters.limit, 100) : 25;
  const clauses = [];
  const params = [];
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (type) { clauses.push('type = ?'); params.push(type); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM feedback ${where}`).get(...params).count;
  const rows = db.prepare(`SELECT * FROM feedback ${where} ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit).map(publicFeedback);
  return { feedback: rows, page, limit, total };
}

function getFeedback(db, id) {
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(normalizeId(id));
  if (!row) throw new FeedbackError(404, 'feedbackNotFound', 'Feedback not found.');
  return publicFeedback(row);
}

function updateFeedback(db, id, body) {
  assertObject(body);
  rejectUnknown(body, ['status', 'internal_note']);
  const feedbackId = normalizeId(id);
  if (body.status === undefined && body.internal_note === undefined) {
    throw new FeedbackError(400, 'noChanges', 'No triage fields were provided.');
  }
  const updates = [];
  const values = [];
  if (body.status !== undefined) { updates.push('status = ?'); values.push(normalizeStatus(body.status)); }
  if (body.internal_note !== undefined) { updates.push('internal_note = ?'); values.push(normalizeInternalNote(body.internal_note)); }
  updates.push("updated_at = datetime('now')");
  values.push(feedbackId);
  const result = db.prepare(`UPDATE feedback SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (result.changes !== 1) throw new FeedbackError(404, 'feedbackNotFound', 'Feedback not found.');
  return getFeedback(db, feedbackId);
}

function deleteFeedback(db, id) {
  const feedbackId = normalizeId(id);
  const result = db.prepare('DELETE FROM feedback WHERE id = ?').run(feedbackId);
  if (result.changes !== 1) throw new FeedbackError(404, 'feedbackNotFound', 'Feedback not found.');
  return { id: feedbackId };
}

module.exports = {
  FEEDBACK_TYPES,
  FEEDBACK_STATUSES,
  FEEDBACK_PATHS,
  MAX_DESCRIPTION_LENGTH,
  MAX_INTERNAL_NOTE_LENGTH,
  FeedbackError,
  createFeedback,
  deleteFeedback,
  getFeedback,
  listFeedback,
  normalizePathname,
  normalizeInternalNote,
  publicFeedback,
  updateFeedback,
};
