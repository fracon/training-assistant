'use strict';

const { verifyPassword, hashPassword } = require('./passwords');
const { createSession, purgeExpiredSessions } = require('./sessions');

const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.';

class LoginError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'LoginError';
    this.status = status;
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
      'SELECT id, email, password_hash, first_name, last_name, preferred_lang FROM users WHERE email = ?'
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

  const session = createSession(db, row.id, sessionOptions);
  return {
    user: {
      id: row.id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      preferred_lang: row.preferred_lang,
    },
    session,
  };
}

module.exports = { loginUser, normalizeCredentials, LoginError, INVALID_CREDENTIALS_MESSAGE };
