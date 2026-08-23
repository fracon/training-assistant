'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE_NAME = 'ta_session';
const TOKEN_BYTES = 32;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toIso(timestampMs) {
  return new Date(timestampMs).toISOString();
}

function createSession(db, userId, { ttlMs = DEFAULT_SESSION_TTL_MS, now = Date.now } = {}) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = toIso(now() + ttlMs);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expiresAt
  );
  return { token, expiresAt };
}

function findActiveSession(db, token) {
  if (!token) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT s.id AS token, s.user_id, s.expires_at,
              u.id AS user_id, u.email, u.first_name, u.last_name, u.preferred_lang
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(token);
  if (!row || Date.parse(row.expires_at) <= Date.now()) {
    return null;
  }
  return {
    token: row.token,
    userId: row.user_id,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      preferred_lang: row.preferred_lang,
    },
  };
}

function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

function purgeExpiredSessions(db, { now = Date.now } = {}) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(toIso(now()));
}

module.exports = {
  SESSION_COOKIE_NAME,
  TOKEN_BYTES,
  DEFAULT_SESSION_TTL_MS,
  createSession,
  findActiveSession,
  deleteSession,
  purgeExpiredSessions,
};
