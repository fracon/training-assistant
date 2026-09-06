'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../src/db/database');
const {
  SESSION_COOKIE_NAME,
  TOKEN_BYTES,
  DEFAULT_SESSION_TTL_MS,
  createSession,
  findActiveSession,
  deleteSession,
  purgeExpiredSessions,
} = require('../src/auth/sessions');

function seedUser(db, email = 'runner@example.com') {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email, 'scrypt$aa$bb');
  return Number(lastInsertRowid);
}

test('session constants are exportable and sensible', () => {
  assert.equal(SESSION_COOKIE_NAME, 'ta_session');
  assert.equal(TOKEN_BYTES, 32);
  assert.equal(DEFAULT_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('createSession stores a random hex token with the default expiry', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);

  const before = Date.now();
  const first = createSession(db, userId);
  const second = createSession(db, userId);
  const after = Date.now();

  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.notEqual(first.token, second.token);

  const expectedMin = new Date(before + DEFAULT_SESSION_TTL_MS).toISOString();
  const expectedMax = new Date(after + DEFAULT_SESSION_TTL_MS).toISOString();
  assert.ok(first.expiresAt >= expectedMin && first.expiresAt <= expectedMax);

  const row = db.prepare('SELECT id, user_id, expires_at FROM sessions WHERE id = ?').get(first.token);
  assert.equal(row.user_id, userId);
  assert.equal(row.expires_at, first.expiresAt);

  db.close();
});

test('createSession honours a custom ttl and clock', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);

  const session = createSession(db, userId, { ttlMs: 5000, now: () => 1_000_000 });
  assert.equal(session.expiresAt, new Date(1_005_000).toISOString());

  db.close();
});

test('createSession rejects sessions for unknown users via foreign keys', () => {
  const db = createDatabase({ filename: ':memory:' });
  assert.throws(
    () => createSession(db, 99999),
    /FOREIGN KEY constraint failed/
  );
  db.close();
});

test('findActiveSession returns null for missing or unknown tokens', () => {
  const db = createDatabase({ filename: ':memory:' });
  assert.equal(findActiveSession(db, ''), null);
  assert.equal(findActiveSession(db, undefined), null);
  assert.equal(findActiveSession(db, 'not-a-real-token'), null);
  db.close();
});

test('findActiveSession returns null for expired tokens', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const expired = createSession(db, userId, { ttlMs: -1000 });
  assert.equal(findActiveSession(db, expired.token), null);
  db.close();
});

test('findActiveSession hydrates the user for valid tokens', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db, 'valid@example.com');
  const session = createSession(db, userId, { now: () => Date.now() });

  const found = findActiveSession(db, session.token);
  assert.deepEqual(found, {
    token: session.token,
    userId,
    expiresAt: session.expiresAt,
    user: {
      id: userId,
      email: 'valid@example.com',
      first_name: null,
      last_name: null,
      preferred_lang: 'en-US',
      first_day_of_week: 'Monday',
      distance_unit: 'km',
      temperature_unit: 'C',
    },
  });

  db.close();
});

test('findActiveSession exposes the stored preferred language', () => {
  const db = createDatabase({ filename: ':memory:' });
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO users (email, password_hash, preferred_lang) VALUES (?, ?, 'pt-BR')"
    )
    .run('pt-runner@example.com', 'scrypt$aa$bb');
  const session = createSession(db, Number(lastInsertRowid));

  const found = findActiveSession(db, session.token);
  assert.equal(found.user.preferred_lang, 'pt-BR');

  db.close();
});

test('deleteSession removes only the targeted token', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const keep = createSession(db, userId);
  const drop = createSession(db, userId);

  deleteSession(db, drop.token);
  assert.equal(findActiveSession(db, drop.token), null);
  assert.notEqual(findActiveSession(db, keep.token), null);

  db.close();
});

test('purgeExpiredSessions deletes stale rows and keeps live ones', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const stale = createSession(db, userId, { ttlMs: -5000 });
  const fresh = createSession(db, userId);

  purgeExpiredSessions(db, { now: () => Date.now() });

  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM sessions WHERE id = ?').get(stale.token).total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM sessions WHERE id = ?').get(fresh.token).total, 1);

  db.close();
});
