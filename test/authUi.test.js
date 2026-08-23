'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidEmail,
  validateLogin,
  validateRegistration,
  MIN_PASSWORD_LENGTH,
} = require('../src/public/auth-ui.js');

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
  assert.match(validateLogin(), /fill in your email and password/);
  assert.match(validateLogin({}), /fill in your email and password/);
  assert.match(validateLogin({ email: '', password: '' }), /fill in your email and password/);
  assert.match(validateLogin({ email: 'runner@example.com' }), /fill in your email and password/);
  assert.match(validateLogin({ password: 'secret123' }), /fill in your email and password/);
});

test('validateLogin rejects malformed emails', () => {
  assert.match(validateLogin({ email: 'not-an-email', password: 'secret123' }), /valid email/);
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
    'Please enter your first name.',
    'Please enter your last name.',
    'Please enter your email.',
    'Please choose a password.',
    'Please confirm your password.',
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
  assert.deepEqual(missingLastName.errors, ['Please enter your last name.']);
  assert.deepEqual(missingLastName.invalid, { last_name: true });

  const badEmail = validateRegistration({ ...validRegistration(), email: 'nope@nope' });
  assert.deepEqual(badEmail.errors, ['Please enter a valid email address.']);
  assert.deepEqual(badEmail.invalid, { email: true });

  const shortPassword = validateRegistration({
    ...validRegistration(),
    password: 'short7',
    confirm: 'short7',
  });
  assert.deepEqual(shortPassword.errors, [
    `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
  ]);
  assert.deepEqual(shortPassword.invalid, { password: true });
  assert.equal(MIN_PASSWORD_LENGTH, 8);

  const mismatch = validateRegistration({ ...validRegistration(), confirm: 'different-1' });
  assert.deepEqual(mismatch.errors, ['Passwords do not match.']);
  assert.deepEqual(mismatch.invalid, { confirm: true });

  const missingConfirm = validateRegistration({ ...validRegistration(), confirm: undefined });
  assert.deepEqual(missingConfirm.errors, ['Please confirm your password.']);
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
  assert.ok(result.errors[0].includes('first name'));
  assert.ok(result.errors[2].includes('email'));
});
