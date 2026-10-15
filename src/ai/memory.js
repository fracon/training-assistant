'use strict';

const { createHash } = require('node:crypto');
const PROFILE_FIELDS = ['experience'];
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
  const profile = db.prepare('SELECT fields_json, version, updated_at FROM ai_profiles WHERE user_id = ?').get(userId);
  const fields = profile ? JSON.parse(profile.fields_json) : {};
  return {
    profile: {
      fields: fields.experience ? { experience: fields.experience } : {},
      version: profile ? profile.version : 0,
      updatedAt: profile ? profile.updated_at : null,
    },
  };
}
// Compatibility archive only. Never imported into active context or updated by public writes.
function readLegacyMemory(db, userId) {
  activeOwner(db, userId);
  const row = db.prepare('SELECT fields_json FROM ai_profiles WHERE user_id = ?').get(userId);
  const fields = Object.fromEntries(Object.entries(row ? JSON.parse(row.fields_json) : {}).filter(([key]) => key !== 'experience'));
  const entries = db.prepare('SELECT id,kind,authority,text,observed_on,state,source_json,version,updated_at FROM ai_memory WHERE user_id = ? ORDER BY observed_on DESC,id').all(userId);
  return { fields, entries };
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
      // Retain archived fields byte-for-byte semantically; expose only experience.
      const stored = db.prepare('SELECT fields_json FROM ai_profiles WHERE user_id = ?').get(userId);
      const fields = stored ? JSON.parse(stored.fields_json) : {};
      for (const [key, value] of Object.entries(body.fields))
        fields[key] = {
          value: text(value),
          authority: 'user_report',
          source: 'prior_experience_editor',
          state: 'current',
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
module.exports = { AiError, hash, activeOwner, exactKeys, date, readMemory, readLegacyMemory, saveProfile };
