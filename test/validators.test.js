'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidEmail,
  validateLogin,
  validateRegistration,
  MIN_PASSWORD_LENGTH,
} = require('../src/public/shared/validators.js');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

const validRegistration = () => ({
  first_name: 'Rafael',
  last_name: 'Vilaça',
  email: 'rafael@example.com',
  password: 'super-secret-1',
  confirm: 'super-secret-1',
});

test('isValidEmail accepts ordinary addresses and rejects malformed ones', () => {
  assert.equal(isValidEmail('runner@example.com'), true);
  assert.equal(isValidEmail('  runner@example.com  '), true);
  assert.equal(isValidEmail('rafael.vilaca+run@sub.example.org'), true);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('no-at-sign'), false);
  assert.equal(isValidEmail('missing-tld@example'), false);
  assert.equal(isValidEmail('@example.com'), false);
  assert.equal(isValidEmail('spaces in@example.com'), false);
  assert.equal(isValidEmail(42), false);
  assert.equal(isValidEmail(null), false);
});

test('validateLogin requires both credentials', () => {
  assert.equal(validateLogin({ email: 'runner@example.com', password: 'secret123' }), '');
  assert.equal(validateLogin(), 'errors.fillBoth');
  assert.equal(validateLogin({}), 'errors.fillBoth');
  assert.equal(validateLogin({ email: '', password: '' }), 'errors.fillBoth');
  assert.equal(validateLogin({ email: 'runner@example.com' }), 'errors.fillBoth');
  assert.equal(validateLogin({ password: 'secret123' }), 'errors.fillBoth');
});

test('validateLogin rejects malformed emails', () => {
  assert.equal(validateLogin({ email: 'not-an-email', password: 'secret123' }), 'errors.invalidEmail');
});

test('every validator key resolves in both locale files', () => {
  const lookup = (messages, path) =>
    path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), messages);
  const keys = [
    validateLogin(),
    validateLogin({ email: 'nope', password: 'secret123' }),
    ...validateRegistration({}).errors,
    ...validateRegistration({ ...validRegistration(), email: 'nope@nope' }).errors,
    ...validateRegistration({ ...validRegistration(), confirm: 'different-1' }).errors,
    ...validateRegistration({
      ...validRegistration(),
      password: 'short7',
      confirm: 'short7',
    }).errors,
  ];
  for (const key of keys) {
    assert.match(key, /^errors\./, key);
    assert.equal(typeof lookup(en, key), 'string', `en.json missing ${key}`);
    assert.equal(typeof lookup(pt, key), 'string', `pt.json missing ${key}`);
  }
  assert.ok(en.errors.passwordMin.includes('{min}'));
  assert.ok(pt.errors.passwordMin.includes('{min}'));
});

test('validateRegistration accepts a complete matching payload', () => {
  const result = validateRegistration({
    first_name: ' Rafael ',
    last_name: 'Vilaça',
    email: 'RAFAEL@Example.com',
    password: 'super-secret-1',
    confirm: 'super-secret-1',
  });
  assert.deepEqual(result, { valid: true, errors: [], invalid: {} });
});

test('validateRegistration aggregates every problem at once', () => {
  const result = validateRegistration({});
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'errors.firstNameRequired',
    'errors.lastNameRequired',
    'errors.emailRequired',
    'errors.choosePassword',
    'errors.confirmRequired',
  ]);
  assert.deepEqual(result.invalid, {
    first_name: true,
    last_name: true,
    email: true,
    password: true,
    confirm: true,
  });
});

test('validateRegistration flags only the offending fields individually', () => {
  const missingLastName = validateRegistration({ ...validRegistration(), last_name: '' });
  assert.deepEqual(missingLastName.errors, ['errors.lastNameRequired']);
  assert.deepEqual(missingLastName.invalid, { last_name: true });

  const badEmail = validateRegistration({ ...validRegistration(), email: 'nope@nope' });
  assert.deepEqual(badEmail.errors, ['errors.invalidEmail']);
  assert.deepEqual(badEmail.invalid, { email: true });

  const shortPassword = validateRegistration({
    ...validRegistration(),
    password: 'short7',
    confirm: 'short7',
  });
  assert.deepEqual(shortPassword.errors, ['errors.passwordMin']);
  assert.deepEqual(shortPassword.invalid, { password: true });
  assert.equal(MIN_PASSWORD_LENGTH, 8);

  const mismatch = validateRegistration({ ...validRegistration(), confirm: 'different-1' });
  assert.deepEqual(mismatch.errors, ['errors.mismatch']);
  assert.deepEqual(mismatch.invalid, { confirm: true });

  const missingConfirm = validateRegistration({ ...validRegistration(), confirm: undefined });
  assert.deepEqual(missingConfirm.errors, ['errors.confirmRequired']);
  assert.deepEqual(missingConfirm.invalid, { confirm: true });
});

test('validateRegistration tolerates non-string junk inputs as missing fields', () => {
  const result = validateRegistration({
    first_name: 42,
    last_name: null,
    email: undefined,
    password: {},
    confirm: [],
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 5);
  assert.equal(result.errors[0], 'errors.firstNameRequired');
  assert.equal(result.errors[2], 'errors.emailRequired');
});
