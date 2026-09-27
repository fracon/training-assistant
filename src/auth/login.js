'use strict';

const { verifyPassword, hashPassword } = require('./passwords');
const { createSession, purgeExpiredSessions } = require('./sessions');

const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.';
// Only reachable with the correct password: an unknown email and a wrong
// password keep the generic message, so this never reveals that an account
// exists before its password was verified.
const INACTIVE_ACCOUNT_MESSAGE = 'Your account is inactive. Please contact the administrator.';
const INACTIVE_ACCOUNT_CODE = 'accountInactive';

class LoginError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'LoginError';
    this.status = status;
    this.code = code;
  }
}

let dummyHash = null;

async function equalizeVerificationTiming(password) {
  if (dummyHash === null) {
    dummyHash = await hashPassword('timing-equalizer');
  }
  await verifyPassword(password, dummyHash);
}

function normalizeCredentials(payload) {
  const body = payload ?? {};
  return {
    email: typeof body.email === 'string' ? body.email.trim().toLowerCase() : '',
    password: typeof body.password === 'string' ? body.password : '',
  };
}

async function loginUser(db, payload, sessionOptions) {
  const { email, password } = normalizeCredentials(payload);
  if (!email || !password) {
    throw new LoginError(400, 'Email and password are required.');
  }

  purgeExpiredSessions(db);

  const row = db
    .prepare(
      'SELECT id, email, password_hash, first_name, last_name, preferred_lang, first_day_of_week, distance_unit, temperature_unit, role, is_active FROM users WHERE email = ?'
    )
    .get(email);

  if (!row) {
    await equalizeVerificationTiming(password);
    throw new LoginError(401, INVALID_CREDENTIALS_MESSAGE);
  }

  const isValid = await verifyPassword(password, row.password_hash);
  if (!isValid) {
    throw new LoginError(401, INVALID_CREDENTIALS_MESSAGE);
  }

  // Verified credentials on a suspended account create no session. The check
  // follows the password verification so the answer cannot be used to discover
  // which addresses belong to inactive accounts.
  if (!row.is_active) {
    throw new LoginError(403, INACTIVE_ACCOUNT_MESSAGE, INACTIVE_ACCOUNT_CODE);
  }

  const session = createSession(db, row.id, sessionOptions);
  return {
    user: {
      id: row.id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      preferred_lang: row.preferred_lang,
      first_day_of_week: row.first_day_of_week,
      distance_unit: row.distance_unit,
      temperature_unit: row.temperature_unit,
      role: row.role,
    },
    session,
  };
}

module.exports = {
  loginUser,
  normalizeCredentials,
  LoginError,
  INVALID_CREDENTIALS_MESSAGE,
  INACTIVE_ACCOUNT_MESSAGE,
  INACTIVE_ACCOUNT_CODE,
};
