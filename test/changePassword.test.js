'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  changePassword,
  normalizePasswordChange,
  validatePasswordChange,
  ChangePasswordError,
  MIN_PASSWORD_LENGTH,
} = require('../src/auth/changePassword');
const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { verifyPassword } = require('../src/auth/passwords');

async function userWithPassword(db, password = 'super-secret-1') {
  const user = await registerUser(db, {
    email: 'rafael@example.com',
    password,
    first_name: 'Rafael',
    last_name: 'Vilaça',
  });
  return user;
}

test('normalizePasswordChange coerces non-string values to empty strings', () => {
  assert.deepEqual(normalizePasswordChange(), {
    currentPassword: '',
    newPassword: '',
    confirmNewPassword: '',
  });
  assert.deepEqual(
    normalizePasswordChange({
      currentPassword: 42,
      newPassword: null,
      confirmNewPassword: undefined,
    }),
    { currentPassword: '', newPassword: '', confirmNewPassword: '' }
  );
  assert.deepEqual(
    normalizePasswordChange({
      currentPassword: 'old-pass-1',
      newPassword: 'new-pass-2',
      confirmNewPassword: 'new-pass-2',
    }),
    {
      currentPassword: 'old-pass-1',
      newPassword: 'new-pass-2',
      confirmNewPassword: 'new-pass-2',
    }
  );
});

test('validatePasswordChange accepts a complete matching payload', () => {
  assert.deepEqual(
    validatePasswordChange({
      currentPassword: 'old-pass-1',
      newPassword: 'brand-new-1',
      confirmNewPassword: 'brand-new-1',
    }),
    []
  );
});

test('validatePasswordChange aggregates every problem at once', () => {
  assert.deepEqual(validatePasswordChange({}), [
    'currentRequired',
    'newRequired',
    'confirmRequired',
  ]);
});

test('validatePasswordChange rejects missing current password', () => {
  assert.deepEqual(
    validatePasswordChange({ newPassword: 'brand-new-1', confirmNewPassword: 'brand-new-1' }),
    ['currentRequired']
  );
});

test('validatePasswordChange rejects missing new password', () => {
  assert.deepEqual(validatePasswordChange({ currentPassword: 'old-pass-1' }), [
    'newRequired',
    'confirmRequired',
  ]);
});

test('validatePasswordChange rejects passwords below the minimum length', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.deepEqual(
    validatePasswordChange({
      currentPassword: 'old-pass-1',
      newPassword: 'short7',
      confirmNewPassword: 'short7',
    }),
    ['passwordMinLength']
  );
});

test('validatePasswordChange rejects mismatched new passwords', () => {
  assert.deepEqual(
    validatePasswordChange({
      currentPassword: 'old-pass-1',
      newPassword: 'brand-new-1',
      confirmNewPassword: 'different-2',
    }),
    ['passwordsMismatch']
  );
});

test('validatePasswordChange rejects a new password identical to the current one', () => {
  assert.deepEqual(
    validatePasswordChange({
      currentPassword: 'same-pass-1',
      newPassword: 'same-pass-1',
      confirmNewPassword: 'same-pass-1',
    }),
    ['sameAsCurrent']
  );
});

test('validatePasswordChange accumulates independent failures at once', () => {
  assert.deepEqual(
    validatePasswordChange({
      currentPassword: 'old-pass-1',
      newPassword: 'short7',
      confirmNewPassword: 'different-2',
    }),
    ['passwordMinLength', 'passwordsMismatch']
  );
});

test('changePassword swaps the stored hash when the current password matches', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const user = await userWithPassword(db, 'original-1');

  const result = await changePassword(db, user.id, {
    currentPassword: 'original-1',
    newPassword: 'brand-new-1',
    confirmNewPassword: 'brand-new-1',
  });
  assert.deepEqual(result, { status: 'ok' });

  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  assert.ok(stored.password_hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword('brand-new-1', stored.password_hash), true);
  assert.equal(await verifyPassword('original-1', stored.password_hash), false);

  db.close();
});

test('changePassword rejects when the current password is wrong', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const user = await userWithPassword(db, 'original-1');

  await assert.rejects(
    changePassword(db, user.id, {
      currentPassword: 'wrong-secret',
      newPassword: 'brand-new-1',
      confirmNewPassword: 'brand-new-1',
    }),
    (error) => {
      assert.ok(error instanceof ChangePasswordError);
      assert.equal(error.status, 401);
      assert.equal(error.message, 'Incorrect current password.');
      assert.deepEqual(error.errors, ['incorrectCurrentPassword']);
      return true;
    }
  );

  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  assert.equal(await verifyPassword('original-1', stored.password_hash), true);

  db.close();
});

test('changePassword rejects unknown user ids', async () => {
  const db = createDatabase({ filename: ':memory:' });

  await assert.rejects(
    changePassword(db, 999, {
      currentPassword: 'original-1',
      newPassword: 'brand-new-1',
      confirmNewPassword: 'brand-new-1',
    }),
    (error) => {
      assert.ok(error instanceof ChangePasswordError);
      assert.equal(error.status, 404);
      assert.equal(error.message, 'User not found.');
      assert.deepEqual(error.errors, ['userNotFound']);
      return true;
    }
  );

  db.close();
});

test('changePassword never writes when validation fails', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const user = await userWithPassword(db, 'original-1');

  await assert.rejects(
    changePassword(db, user.id, {
      currentPassword: 'original-1',
      newPassword: 'short7',
      confirmNewPassword: 'short7',
    }),
    (error) => {
      assert.ok(error instanceof ChangePasswordError);
      assert.equal(error.status, 400);
      assert.equal(error.message, 'Invalid password change request.');
      assert.deepEqual(error.errors, ['passwordMinLength']);
      return true;
    }
  );

  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  assert.equal(await verifyPassword('original-1', stored.password_hash), true);

  db.close();
});

test('changePassword reports every validation problem at once', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const user = await userWithPassword(db, 'original-1');

  await assert.rejects(
    changePassword(db, user.id, {}),
    (error) => {
      assert.ok(error instanceof ChangePasswordError);
      assert.equal(error.status, 400);
      assert.deepEqual(error.errors, ['currentRequired', 'newRequired', 'confirmRequired']);
      return true;
    }
  );

  db.close();
});