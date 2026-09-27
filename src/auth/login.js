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

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    preferred_lang: row.preferred_lang,
    first_day_of_week: row.first_day_of_week,
    distance_unit: row.distance_unit,
    temperature_unit: row.temperature_unit,
    role: row.role,
  };
}

// The account state and the session row are written in one immediate
// transaction, on purpose. `verifyPassword` awaits scrypt on the thread pool, so
// anything can be committed while it runs: an administrator can suspend or
// delete the account, and a suspension revokes every session of that account. The
// state therefore cannot be trusted from the row read before the wait, and it
// cannot be checked after the session insert either — that would leave a window in
// which a suspended account is handed a token. `immediate` takes the write lock
// up front, so the re-read and the insert are a single atomic step: a suspension
// committed during the verification is observed here and the login is refused
// with no session, and the returned profile is the row that was re-read rather
// than a stale copy.
function openSessionForVerifiedAccount(db, userId, sessionOptions) {
  const open = db.transaction(() => {
    const current = db
      .prepare(
        `SELECT id, email, first_name, last_name, preferred_lang, first_day_of_week,
                distance_unit, temperature_unit, role, is_active
         FROM users WHERE id = ?`
      )
      .get(userId);
    if (!current) {
      // The account was removed while the password was being verified, so there
      // is no longer anything these credentials can authenticate. The answer is
      // the same one an unknown address receives.
      throw new LoginError(401, INVALID_CREDENTIALS_MESSAGE);
    }
    if (!current.is_active) {
      throw new LoginError(403, INACTIVE_ACCOUNT_MESSAGE, INACTIVE_ACCOUNT_CODE);
    }
    return { account: current, session: createSession(db, userId, sessionOptions) };
  });
  return open.immediate();
}

async function loginUser(db, payload, sessionOptions) {
  const { email, password } = normalizeCredentials(payload);
  if (!email || !password) {
    throw new LoginError(400, 'Email and password are required.');
  }

  purgeExpiredSessions(db);

  // Only what the verification needs: the profile and the state are read again
  // after it, because this row is already stale by then.
  const row = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);

  if (!row) {
    await equalizeVerificationTiming(password);
    throw new LoginError(401, INVALID_CREDENTIALS_MESSAGE);
  }

  // The password is verified before the account state is ever considered, so
  // only a caller that already knows the credentials can learn that the account
  // exists and is suspended; an unknown address or a wrong password keeps the
  // generic answer above. Because the verification awaited, the row read here can
  // already be stale, so the state is re-read and the session inserted together.
  const isValid = await verifyPassword(password, row.password_hash);
  if (!isValid) {
    throw new LoginError(401, INVALID_CREDENTIALS_MESSAGE);
  }

  const { account, session } = openSessionForVerifiedAccount(db, row.id, sessionOptions);
  return { user: publicUser(account), session };
}

module.exports = {
  loginUser,
  normalizeCredentials,
  LoginError,
  INVALID_CREDENTIALS_MESSAGE,
  INACTIVE_ACCOUNT_MESSAGE,
  INACTIVE_ACCOUNT_CODE,
};
