'use strict';

// Sign-in verifies the password with scrypt, which runs on the thread pool, so
// the account row is read before an `await` and can be stale by the time the
// verification finishes. This suite holds that verification open and suspends the
// account inside the window, reproducing the exact order a caller can hit:
//
//   start login with the correct password -> suspend the account -> verification
//   finishes
//
// The account must still be refused, and no session may be written. The stub is
// installed before `src/auth/login` is loaded, because that module binds
// `verifyPassword` when it is required. `node --test` runs every suite in its own
// process, so the stub cannot leak into another file.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../src/db/database');
const { setAccountActivity } = require('../src/admin/users');
const passwords = require('../src/auth/passwords');

const { hashPassword } = passwords;
const realVerifyPassword = passwords.verifyPassword;

let control = null;

// `entered` resolves once the login has read the account and is now inside the
// verification, which is what makes the reproduction deterministic: the test
// waits for it instead of guessing how long scrypt takes.
passwords.verifyPassword = async (password, storedHash) => {
  if (control) {
    control.markEntered();
    await control.gate;
  }
  return realVerifyPassword(password, storedHash);
};

const {
  loginUser,
  LoginError,
  INVALID_CREDENTIALS_MESSAGE,
  INACTIVE_ACCOUNT_MESSAGE,
  INACTIVE_ACCOUNT_CODE,
} = require('../src/auth/login');
const { findActiveSession } = require('../src/auth/sessions');
const { buildServer } = require('../src/server');

function holdVerification() {
  let release;
  let markEntered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  control = { gate, markEntered, entered, release: () => release() };
  return {
    async waitUntilEntered() {
      await control.entered;
    },
    release() {
      const current = control;
      control = null;
      current.release();
    },
  };
}

async function seedAccount(db, { email, password, role = 'user', isActive = true }) {
  const passwordHash = await hashPassword(password);
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO users (email, password_hash, role, is_active, onboarding_status) VALUES (?, ?, ?, ?, ?)'
    )
    .run(email, passwordHash, role, isActive ? 1 : 0, isActive ? 'active' : 'new');
  return Number(lastInsertRowid);
}

function sessionCount(db) {
  return db.prepare('SELECT COUNT(*) AS total FROM sessions').get().total;
}

test('a suspension committed while the password is verified refuses the login', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  const password = 'super-secret-1';
  const userId = await seedAccount(db, { email: 'rafael@example.com', password });
  const admin = { id: await seedAccount(db, { email: 'root@example.com', password, role: 'admin' }), email: 'root@example.com' };

  // A session from before the suspension, which the transition must revoke.
  const { session: previous } = await loginUser(db, {
    email: 'rafael@example.com',
    password,
  });
  assert.equal(sessionCount(db), 1);

  const held = holdVerification();
  const attempt = loginUser(db, { email: 'rafael@example.com', password });
  // The account row has been read and the verification is pending: the row the
  // login holds is now provably pre-suspension.
  await held.waitUntilEntered();

  setAccountActivity(db, admin, userId, { active: false, expected_active: true });
  held.release();

  await assert.rejects(attempt, (error) => {
    assert.ok(error instanceof LoginError);
    assert.equal(error.status, 403);
    assert.equal(error.message, INACTIVE_ACCOUNT_MESSAGE);
    assert.equal(error.code, INACTIVE_ACCOUNT_CODE);
    return true;
  });

  // The suspended login wrote no session, and the previous one is gone too.
  assert.equal(sessionCount(db), 0, 'no session survives the suspension');
  assert.equal(findActiveSession(db, previous.token), null, 'the old token is refused');
  assert.equal(
    db.prepare('SELECT is_active FROM users WHERE id = ?').get(userId).is_active,
    0,
    'the account stays suspended'
  );
});

test('the suspended race answers over HTTP without a session cookie', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  const app = await buildServer({ db, sessionCookieSecure: false });
  t.after(() => app.close());
  const password = 'super-secret-1';
  const userId = await seedAccount(db, { email: 'rafael@example.com', password });
  const admin = {
    id: await seedAccount(db, { email: 'root@example.com', password, role: 'admin' }),
    email: 'root@example.com',
  };

  const held = holdVerification();
  const pending = app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'rafael@example.com', password },
  });
  await held.waitUntilEntered();
  setAccountActivity(db, admin, userId, { active: false, expected_active: true });
  held.release();
  const response = await pending;

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json().errors, ['accountInactive']);
  assert.equal(response.headers['set-cookie'], undefined, 'no session cookie is issued');
  assert.equal(sessionCount(db), 0);
  const me = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(me.statusCode, 401, 'nothing can be authenticated with that account');
});

test('reactivation after the race signs in again without reviving the old token', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  const password = 'super-secret-1';
  const email = 'rafael@example.com';
  const userId = await seedAccount(db, { email, password });
  const admin = {
    id: await seedAccount(db, { email: 'root@example.com', password, role: 'admin' }),
    email: 'root@example.com',
  };
  // A record that must survive the whole suspension cycle.
  db.prepare(
    "INSERT INTO trainings (user_id, dia, tipo, treino) VALUES (?, '2026-09-01', 'easy', 'keep me')"
  ).run(userId);

  const { session: beforeSuspension } = await loginUser(db, { email, password });

  const held = holdVerification();
  const attempt = loginUser(db, { email, password });
  await held.waitUntilEntered();
  setAccountActivity(db, admin, userId, { active: false, expected_active: true });
  held.release();
  await assert.rejects(attempt, (error) => error.code === INACTIVE_ACCOUNT_CODE);
  assert.equal(findActiveSession(db, beforeSuspension.token), null);

  setAccountActivity(db, admin, userId, { active: true, expected_active: false });
  const { user, session: afterReactivation } = await loginUser(db, { email, password });
  assert.equal(user.id, userId);
  assert.notEqual(afterReactivation.token, beforeSuspension.token);
  assert.equal(
    findActiveSession(db, beforeSuspension.token),
    null,
    'reactivation does not restore the revoked token'
  );
  assert.ok(findActiveSession(db, afterReactivation.token), 'the new session works');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS total FROM trainings WHERE user_id = ?').get(userId).total,
    1,
    'the account keeps its data'
  );
});

test('a wrong password still fails generically while the verification is held', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  await seedAccount(db, { email: 'rafael@example.com', password: 'super-secret-1' });

  const held = holdVerification();
  const attempt = loginUser(db, { email: 'rafael@example.com', password: 'wrong-password' });
  await held.waitUntilEntered();
  held.release();

  await assert.rejects(attempt, (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message, INVALID_CREDENTIALS_MESSAGE);
    assert.equal(error.code, undefined, 'no stable code leaks the account state');
    return true;
  });
  assert.equal(sessionCount(db), 0);
});

test('an account removed while the password is verified fails like an unknown one', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  await seedAccount(db, { email: 'ghost@example.com', password: 'super-secret-1' });

  const held = holdVerification();
  const attempt = loginUser(db, { email: 'ghost@example.com', password: 'super-secret-1' });
  await held.waitUntilEntered();
  db.prepare("DELETE FROM users WHERE email = 'ghost@example.com'").run();
  held.release();

  await assert.rejects(attempt, (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message, INVALID_CREDENTIALS_MESSAGE);
    return true;
  });
  assert.equal(sessionCount(db), 0);
});
