'use strict';

const { hashPassword } = require('../auth/passwords');
const { normalizeRegistration, validateRegistration } = require('../auth/registration');

class AdminOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdminOperationError';
    this.code = code;
  }
}

function publicAccount(row) {
  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
  };
}

function hasAdministrator(db) {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get());
}

function findAccountByEmail(db, email) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalized) return null;
  const row = db.prepare('SELECT id, email, first_name, last_name, role FROM users WHERE email = ?').get(normalized);
  return row ? publicAccount(row) : null;
}

async function createFirstAdmin(db, payload) {
  const account = normalizeRegistration(payload);
  validateRegistration(account);
  if (hasAdministrator(db)) throw new AdminOperationError('ADMIN_EXISTS', 'An administrator already exists.');
  if (findAccountByEmail(db, account.email)) {
    throw new AdminOperationError('EMAIL_IN_USE', 'This email belongs to an existing account; use admin:promote instead.');
  }

  // Password derivation stays outside the write transaction. Conditions are rechecked atomically below.
  const passwordHash = await hashPassword(account.password);
  const create = db.transaction(() => {
    if (hasAdministrator(db)) throw new AdminOperationError('ADMIN_EXISTS', 'An administrator already exists.');
    if (findAccountByEmail(db, account.email)) {
      throw new AdminOperationError('EMAIL_IN_USE', 'This email belongs to an existing account; use admin:promote instead.');
    }
    const result = db.prepare(
      `INSERT INTO users
        (email, password_hash, first_name, last_name, preferred_lang, first_day_of_week,
         distance_unit, temperature_unit, onboarding_status, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', 'admin')`
    ).run(
      account.email, passwordHash, account.first_name, account.last_name,
      account.preferred_lang, account.first_day_of_week, account.distance_unit, account.temperature_unit
    );
    return publicAccount(db.prepare('SELECT id, email, first_name, last_name, role FROM users WHERE id = ?').get(Number(result.lastInsertRowid)));
  });
  return create.immediate();
}

function promoteAccount(db, email) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalized) throw new AdminOperationError('INVALID_EMAIL', 'Enter a valid account email.');
  const promote = db.transaction(() => {
    const account = db.prepare('SELECT id, email, first_name, last_name, role FROM users WHERE email = ?').get(normalized);
    if (!account) throw new AdminOperationError('ACCOUNT_NOT_FOUND', 'No account exists with that email.');
    if (account.role === 'admin') return { changed: false, user: publicAccount(account) };
    const result = db.prepare("UPDATE users SET role = 'admin' WHERE id = ? AND role = 'user'").run(account.id);
    if (result.changes !== 1) throw new AdminOperationError('INVALID_ROLE', 'The account has an unsupported role.');
    return {
      changed: true,
      user: publicAccount({ ...account, role: 'admin' }),
    };
  });
  return promote.immediate();
}

module.exports = {
  AdminOperationError,
  hasAdministrator,
  findAccountByEmail,
  createFirstAdmin,
  promoteAccount,
};
