'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerUser,
  validateRegistration,
  normalizeRegistration,
  RegistrationError,
} = require('../src/auth/registration');
const { createDatabase } = require('../src/db/database');
const { verifyPassword } = require('../src/auth/passwords');

function buildRegistration(overrides = {}) {
  return {
    email: 'rafael@example.com',
    password: 'super-secret-1',
    first_name: 'Rafael',
    last_name: 'Vilaça',
    ...overrides,
  };
}

test('normalizeRegistration trims fields, lowercases the email and tolerates a missing body', () => {
  assert.deepEqual(
    normalizeRegistration({
      email: '  Rafael@Example.COM ',
      password: '  keep-spaces-out-of-hash-only  ',
      first_name: ' Rafael ',
      last_name: ' Vilaça ',
    }),
    {
      email: 'rafael@example.com',
      password: '  keep-spaces-out-of-hash-only  ',
      first_name: 'Rafael',
      last_name: 'Vilaça',
    }
  );

  assert.deepEqual(normalizeRegistration(undefined), {
    email: '',
    password: '',
    first_name: '',
    last_name: '',
  });

  assert.deepEqual(normalizeRegistration({ email: 42 }), {
    email: '',
    password: '',
    first_name: '',
    last_name: '',
  });
});

test('validateRegistration reports every missing field at once', () => {
  assert.throws(
    () => validateRegistration({ email: '', password: '', first_name: '', last_name: '' }),
    (error) =>
      error instanceof RegistrationError &&
      error.status === 400 &&
      error.message ===
        'Missing required fields: email, password, first_name, last_name.'
  );
});

test('validateRegistration rejects invalid emails and short passwords', () => {
  assert.throws(
    () =>
      validateRegistration(
        normalizeRegistration(buildRegistration({ email: 'not-an-email' }))
      ),
    (error) =>
      error instanceof RegistrationError &&
      error.status === 400 &&
      error.message === 'Invalid email address.'
  );

  assert.throws(
    () =>
      validateRegistration(
        normalizeRegistration(buildRegistration({ password: 'short' }))
      ),
    (error) =>
      error instanceof RegistrationError &&
      error.status === 400 &&
      error.message === 'Password must be at least 8 characters long.'
  );
});

test('registerUser persists a hashed user and returns data without the hash', async () => {
  const db = createDatabase({ filename: ':memory:' });

  const user = await registerUser(db, buildRegistration());

  assert.deepEqual(user, {
    id: 1,
    email: 'rafael@example.com',
    first_name: 'Rafael',
    last_name: 'Vilaça',
  });
  assert.equal('password_hash' in user, false);

  const row = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(user.id);
  assert.equal(row.email, 'rafael@example.com');
  assert.match(row.password_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(row.password_hash, 'super-secret-1');
  assert.equal(await verifyPassword('super-secret-1', row.password_hash), true);

  db.close();
});

test('registerUser rejects duplicate emails regardless of letter casing', async () => {
  const db = createDatabase({ filename: ':memory:' });
  await registerUser(db, buildRegistration());

  await assert.rejects(
    () => registerUser(db, buildRegistration({ email: 'RAFAEL@EXAMPLE.COM' })),
    (error) =>
      error instanceof RegistrationError &&
      error.status === 409 &&
      error.message === 'This email is already registered.'
  );

  db.close();
});

test('registerUser propagates validation failures before touching the database', async () => {
  const db = createDatabase({ filename: ':memory:' });

  await assert.rejects(
    () => registerUser(db, buildRegistration({ password: '' })),
    (error) => error instanceof RegistrationError && error.status === 400
  );

  const users = db.prepare('SELECT COUNT(*) AS total FROM users').get();
  assert.equal(users.total, 0);

  db.close();
});
