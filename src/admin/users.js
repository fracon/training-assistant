'use strict';

const { hashPassword } = require('../auth/passwords');
const {
  normalizeEmail,
  normalizeRegistration,
  validateEmail,
  validateRegistration,
} = require('../auth/registration');
const { findAccountByEmail } = require('./operations');

const ACCOUNT_ROLES = ['user', 'admin'];
const ADMIN_ROLE = 'admin';
const CREATE_FIELDS = ['first_name', 'last_name', 'email', 'password', 'role'];
const UPDATE_FIELDS = ['first_name', 'last_name', 'email', 'role'];

const ACTION_CREATED = 'account_created';
const ACTION_UPDATED = 'account_updated';
const ACTION_ROLE_CHANGED = 'account_role_changed';
const ACTION_DELETED = 'account_deleted';

// Every failure carries a stable machine code alongside the HTTP status so the
// routes stay thin and the interface can localize without parsing prose.
class AdminUserError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AdminUserError';
    this.status = status;
    this.code = code;
  }
}

function normalizeAccountId(value) {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new AdminUserError(400, 'invalidId', 'Invalid account id.');
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AdminUserError(400, 'invalidId', 'Invalid account id.');
  }
  return id;
}

function normalizeRole(value) {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ACCOUNT_ROLES.includes(role)) {
    throw new AdminUserError(400, 'invalidRole', 'Unsupported account role.');
  }
  return role;
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Callers normalize the body with `payload ?? {}` before reaching this check.
function rejectUnknownFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new AdminUserError(400, 'unknownField', `Unsupported field: ${key}.`);
    }
  }
}

// Registration's own validation failures become admin errors with a stable code,
// so every admin route answers with one error envelope. Only the registration
// validators are wrapped, and they always fail with a `status`.
function mapRegistrationError(error) {
  return new AdminUserError(error.status, 'invalidRegistration', error.message);
}

const ACCOUNT_COLUMNS = 'id, email, first_name, last_name, role, created_at';

function publicAccount(row) {
  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
    created_at: row.created_at ?? null,
  };
}

function countAdministrators(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
}

// The audit trail stores identification, action and date only. Identities are
// copied rather than joined so a deletion record outlives the deleted account.
function recordAudit(db, { actor, target, action, details }) {
  db.prepare(
    `INSERT INTO admin_audit_log
      (actor_user_id, actor_email, target_user_id, target_email, action, details)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    actor?.id ?? null,
    actor?.email ?? '',
    target.id,
    target.email,
    action,
    JSON.stringify(details)
  );
}

function listAccounts(db) {
  return db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users ORDER BY created_at ASC, id ASC`)
    .all()
    .map(publicAccount);
}

function getAccount(db, id) {
  const accountId = normalizeAccountId(id);
  const row = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?`).get(accountId);
  if (!row) {
    throw new AdminUserError(404, 'accountNotFound', 'Account not found.');
  }
  return publicAccount(row);
}

async function createAccount(db, actor, payload) {
  const body = payload ?? {};
  rejectUnknownFields(body, CREATE_FIELDS);

  // Registration owns email normalization, the email pattern, the password
  // length rule and the hashing parameters; only the role is admin-specific.
  const registration = normalizeRegistration(body);
  try {
    validateRegistration(registration);
  } catch (error) {
    throw mapRegistrationError(error);
  }
  const role = normalizeRole(body.role);

  if (findAccountByEmail(db, registration.email)) {
    throw new AdminUserError(409, 'emailInUse', 'This email is already registered.');
  }

  // Password derivation stays outside the write transaction so a slow scrypt
  // never holds the database write lock; the email is rechecked atomically.
  const passwordHash = await hashPassword(registration.password);
  const create = db.transaction(() => {
    if (findAccountByEmail(db, registration.email)) {
      throw new AdminUserError(409, 'emailInUse', 'This email is already registered.');
    }
    const result = db
      .prepare(
        `INSERT INTO users
          (email, password_hash, first_name, last_name, preferred_lang, first_day_of_week,
           distance_unit, temperature_unit, onboarding_status, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
      )
      .run(
        registration.email,
        passwordHash,
        registration.first_name,
        registration.last_name,
        registration.preferred_lang,
        registration.first_day_of_week,
        registration.distance_unit,
        registration.temperature_unit,
        role
      );
    const account = publicAccount(
      db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?`).get(Number(result.lastInsertRowid))
    );
    recordAudit(db, {
      actor,
      target: account,
      action: ACTION_CREATED,
      details: { role },
    });
    return account;
  });
  return create.immediate();
}

function updateAccount(db, actor, id, payload) {
  const accountId = normalizeAccountId(id);
  const body = payload ?? {};
  rejectUnknownFields(body, UPDATE_FIELDS);

  const updates = {};
  for (const key of UPDATE_FIELDS) {
    if (body[key] !== undefined) updates[key] = body[key];
  }
  if (Object.keys(updates).length === 0) {
    throw new AdminUserError(400, 'noChanges', 'No account fields were provided.');
  }

  if (updates.email !== undefined) {
    const email = normalizeEmail(updates.email);
    try {
      validateEmail(email);
    } catch (error) {
      throw mapRegistrationError(error);
    }
    updates.email = email;
  }
  if (updates.first_name !== undefined) updates.first_name = normalizeName(updates.first_name);
  if (updates.last_name !== undefined) updates.last_name = normalizeName(updates.last_name);
  if (updates.role !== undefined) updates.role = normalizeRole(updates.role);

  const apply = db.transaction(() => {
    const current = db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?`)
      .get(accountId);
    if (!current) {
      throw new AdminUserError(404, 'accountNotFound', 'Account not found.');
    }
    if (updates.email !== undefined && updates.email !== current.email) {
      const owner = findAccountByEmail(db, updates.email);
      if (owner && owner.id !== accountId) {
        throw new AdminUserError(409, 'emailInUse', 'This email is already registered.');
      }
    }

    const roleChanged = updates.role !== undefined && updates.role !== current.role;
    if (roleChanged && current.role === ADMIN_ROLE) {
      // Losing your own administration from the panel would silently end the
      // current session's access, and removing the last administrator would
      // leave the installation unmanageable. Both are refused in the same write
      // transaction that would otherwise persist the change.
      if (accountId === actor.id) {
        throw new AdminUserError(
          400,
          'selfRoleChangeForbidden',
          'You cannot change your own role from the administration panel.'
        );
      }
      if (countAdministrators(db) <= 1) {
        throw new AdminUserError(
          409,
          'lastAdministrator',
          'The last administrator cannot be demoted.'
        );
      }
    }

    const assignments = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(', ');
    const result = db
      .prepare(`UPDATE users SET ${assignments} WHERE id = ?`)
      .run(...Object.values(updates), accountId);
    if (result.changes !== 1) {
      throw new AdminUserError(404, 'accountNotFound', 'Account not found.');
    }

    // A role change must not leave a stale permission in an existing session.
    if (roleChanged) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(accountId);
    }

    const account = publicAccount(
      db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?`).get(accountId)
    );
    recordAudit(db, {
      actor,
      target: account,
      action: roleChanged ? ACTION_ROLE_CHANGED : ACTION_UPDATED,
      details: {
        fields: Object.keys(updates),
        ...(roleChanged ? { role: { from: current.role, to: account.role } } : {}),
      },
    });
    return account;
  });
  return apply.immediate();
}

function deleteAccount(db, actor, id) {
  const accountId = normalizeAccountId(id);
  const remove = db.transaction(() => {
    const current = db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?`)
      .get(accountId);
    if (!current) {
      throw new AdminUserError(404, 'accountNotFound', 'Account not found.');
    }
    if (accountId === actor.id) {
      throw new AdminUserError(
        400,
        'selfDeleteForbidden',
        'You cannot delete your own account from the administration panel.'
      );
    }
    if (current.role === ADMIN_ROLE && countAdministrators(db) <= 1) {
      throw new AdminUserError(
        409,
        'lastAdministrator',
        'The last administrator cannot be deleted.'
      );
    }

    // Foreign keys cascade this account's sessions, trainings, cycles, shoes,
    // mileage ledger and AI Coach availability. Recorded after the delete so
    // the row survives, and it never carries a password, hash, token or
    // training value.
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(accountId);
    if (result.changes !== 1) {
      throw new AdminUserError(404, 'accountNotFound', 'Account not found.');
    }
    recordAudit(db, {
      actor,
      target: current,
      action: ACTION_DELETED,
      details: { role: current.role },
    });
    return { deleted: current };
  });
  return remove.immediate();
}

module.exports = {
  ACCOUNT_ROLES,
  AdminUserError,
  countAdministrators,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  publicAccount,
  updateAccount,
};
