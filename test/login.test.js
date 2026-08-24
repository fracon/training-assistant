'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../src/db/database');
const { hashPassword } = require('../src/auth/passwords');
const {
  loginUser,
  normalizeCredentials,
  LoginError,
  INVALID_CREDENTIALS_MESSAGE,
} = require('../src/auth/login');

async function seedUser(db, email, password) {
  const passwordHash = await hashPassword(password);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email, passwordHash);
  return Number(lastInsertRowid);
}

test('normalizeCredentials trims, lowercases the email and tolerates junk', () => {
  assert.deepEqual(normalizeCredentials(), { email: '', password: '' });
  assert.deepEqual(normalizeCredentials(null), { email: '', password: '' });
  assert.deepEqual(
    normalizeCredentials({ email: '  Rafael@Example.COM ', password: ' secret ' }),
    { email: 'rafael@example.com', password: ' secret ' }
  );
  assert.deepEqual(normalizeCredentials({ email: 42, password: null }), {
    email: '',
    password: '',
  });
});

test('loginUser authenticates with a case-insensitive email and stores the session', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = await seedUser(db, 'rafael@example.com', 'super-secret-1');

  const { user, session } = await loginUser(
    db,
    { email: 'RAFAEL@Example.com', password: 'super-secret-1' }
  );

  assert.deepEqual(user, {
    id: userId,
    email: 'rafael@example.com',
    first_name: null,
    last_name: null,
    preferred_lang: 'en-US',
    first_day_of_week: 'Monday',
  });
  assert.match(session.token, /^[0-9a-f]{64}$/);

  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(session.token);
  assert.equal(row.user_id, userId);
  assert.ok(Date.parse(row.expires_at) > Date.now());

  db.close();
});

test('loginUser returns the stored preferred language with the profile', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const passwordHash = await hashPassword('super-secret-1');
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO users (email, password_hash, preferred_lang) VALUES (?, ?, 'pt-BR')"
    )
    .run('bilingual@example.com', passwordHash);

  const { user } = await loginUser(db, {
    email: 'bilingual@example.com',
    password: 'super-secret-1',
  });

  assert.equal(user.preferred_lang, 'pt-BR');
  assert.equal(user.id, Number(lastInsertRowid));

  db.close();
});

test('loginUser rejects wrong passwords with a generic message', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  await seedUser(db, 'rafael@example.com', 'super-secret-1');

  await assert.rejects(
    loginUser(db, { email: 'rafael@example.com', password: 'wrong-password' }),
    (error) => {
      assert.ok(error instanceof LoginError);
      assert.equal(error.status, 401);
      assert.equal(error.message, INVALID_CREDENTIALS_MESSAGE);
      return true;
    }
  );
});

test('loginUser answers unknown emails with the same generic message', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());

  for (const email of ['ghost@example.com', 'phantom@example.com']) {
    await assert.rejects(
      loginUser(db, { email, password: 'whatever-1' }),
      (error) => {
        assert.ok(error instanceof LoginError);
        assert.equal(error.status, 401);
        assert.equal(error.message, INVALID_CREDENTIALS_MESSAGE);
        assert.equal(error.message, 'Invalid email or password.');
        return true;
      }
    );
  }

  const sessions = db.prepare('SELECT COUNT(*) AS total FROM sessions').get();
  assert.equal(sessions.total, 0);
});

test('loginUser requires both email and password', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());

  await assert.rejects(loginUser(db), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.message, 'Email and password are required.');
    return true;
  });

  await assert.rejects(loginUser(db, { email: 'rafael@example.com' }), (error) => {
    assert.equal(error.status, 400);
    return true;
  });

  await assert.rejects(loginUser(db, { password: 'super-secret-1' }), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
});
