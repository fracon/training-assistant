'use strict';

const { randomUUID, createHash } = require('node:crypto');
const PROFILE_FIELDS = ['experience', 'goals', 'preferences', 'restrictions'];
class AiError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function activeOwner(db, userId) {
  const user = db
    .prepare(
      'SELECT id, role, is_active, preferred_lang, distance_unit, temperature_unit FROM users WHERE id = ?',
    )
    .get(userId);
  if (!user || user.is_active !== 1)
    throw new AiError('accountUnavailable', 401);
  return user;
}
function exactKeys(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new AiError('invalidFields');
}
function text(value, max = 2000) {
  if (typeof value !== 'string' || value.length > max)
    throw new AiError('invalidText');
  return value.trim();
}
function date(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new AiError('invalidDate');
  return value;
}
function readMemory(db, userId) {
  activeOwner(db, userId);
  const profile = db
    .prepare(
      'SELECT fields_json, version, updated_at FROM ai_profiles WHERE user_id = ?',
    )
    .get(userId);
  return {
    profile: profile
      ? {
          fields: JSON.parse(profile.fields_json),
          version: profile.version,
          updatedAt: profile.updated_at,
        }
      : { fields: {}, version: 0, updatedAt: null },
    entries: db
      .prepare(
        'SELECT * FROM ai_memory WHERE user_id = ? ORDER BY observed_on DESC,id',
      )
      .all(userId)
      .map((row) => ({
        ...row,
        source: JSON.parse(row.source_json),
        source_json: undefined,
        user_id: undefined,
      })),
  };
}
function saveProfile(db, userId, body, now = new Date().toISOString()) {
  exactKeys(body, ['fields', 'expected_version']);
  exactKeys(body.fields, PROFILE_FIELDS);
  if (!Number.isInteger(body.expected_version) || body.expected_version < 0)
    throw new AiError('invalidVersion');
  return db
    .transaction(() => {
      const old = readMemory(db, userId).profile;
      if (old.version !== body.expected_version)
        throw new AiError('memoryConflict', 409);
      const fields = { ...old.fields };
      for (const [key, value] of Object.entries(body.fields))
        fields[key] = {
          value: text(value),
          authority: 'user_report',
          source: 'profile_editor',
          state: key === 'restrictions' ? 'unconfirmed' : 'current',
          observedOn: now.slice(0, 10),
          updatedAt: now,
        };
      db.prepare(
        `INSERT INTO ai_profiles(user_id, fields_json, version, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET fields_json=excluded.fields_json, version=excluded.version, updated_at=excluded.updated_at`,
      ).run(userId, JSON.stringify(fields), old.version + 1, now);
      return readMemory(db, userId);
    })
    .immediate();
}
function saveEntry(
  db,
  userId,
  body,
  id = randomUUID(),
  now = new Date().toISOString(),
) {
  exactKeys(body, ['kind', 'text', 'observed_on', 'state', 'expected_version']);
  if (
    !['restriction', 'milestone', 'interruption', 'action'].includes(
      body.kind,
    ) ||
    !['current', 'resolved', 'unconfirmed'].includes(body.state) ||
    !Number.isInteger(body.expected_version) ||
    body.expected_version < 0
  )
    throw new AiError('invalidEntry');
  const value = text(body.text);
  if (!value) throw new AiError('invalidText');
  date(body.observed_on);
  return db
    .transaction(() => {
      activeOwner(db, userId);
      const old = db
        .prepare('SELECT * FROM ai_memory WHERE id = ? AND user_id = ?')
        .get(id, userId);
      if (
        !old &&
        (body.expected_version !== 0 ||
          db.prepare('SELECT 1 FROM ai_memory WHERE id = ?').get(id))
      )
        throw new AiError('memoryNotFound', 404);
      if (old && old.version !== body.expected_version)
        throw new AiError('memoryConflict', 409);
      const authority = body.kind === 'action' ? 'user_action' : 'user_report';
      const source = JSON.stringify({
        origin: 'memory_editor',
        recordedAt: now,
        originalObservedOn: old
          ? JSON.parse(old.source_json).originalObservedOn
          : body.observed_on,
      });
      db.prepare(
        `INSERT INTO ai_memory(id,user_id,kind,authority,text,observed_on,state,source_json,version,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,authority=excluded.authority,text=excluded.text,observed_on=excluded.observed_on,state=excluded.state,source_json=excluded.source_json,version=excluded.version,updated_at=excluded.updated_at WHERE ai_memory.user_id=excluded.user_id`,
      ).run(
        id,
        userId,
        body.kind,
        authority,
        value,
        body.observed_on,
        body.state,
        source,
        (old?.version || 0) + 1,
        now,
      );
      return readMemory(db, userId);
    })
    .immediate();
}
function deleteEntry(db, userId, id) {
  activeOwner(db, userId);
  if (
    !db
      .prepare('DELETE FROM ai_memory WHERE id = ? AND user_id = ?')
      .run(id, userId).changes
  )
    throw new AiError('memoryNotFound', 404);
}
module.exports = {
  AiError,
  hash,
  activeOwner,
  exactKeys,
  date,
  readMemory,
  saveProfile,
  saveEntry,
  deleteEntry,
};
