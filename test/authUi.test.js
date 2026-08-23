'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidEmail,
  validateLogin,
  validateRegistration,
  MIN_PASSWORD_LENGTH,
} = require('../src/public/auth-ui.js');

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
  assert.equal(result, '');
});

test('validateRegistration reports each missing field', () => {
  assert.match(validateRegistration(), /enter your first name/);
  assert.match(validateRegistration({ first_name: 'Rafael' }), /enter your last name/);
  assert.match(validateRegistration({ first_name: 'R', last_name: 'V' }), /enter your email/);
  assert.match(
    validateRegistration({ first_name: 'R', last_name: 'V', email: 'r@example.com' }),
    /choose a password/
  );
});

test('validateRegistration enforces email format and minimum length', () => {
  assert.match(
    validateRegistration({
      first_name: 'R',
      last_name: 'V',
      email: 'invalid-email',
      password: 'super-secret-1',
      confirm: 'super-secret-1',
    }),
    /valid email/
  );

  const shortPassword = validateRegistration({
    first_name: 'R',
    last_name: 'V',
    email: 'r@example.com',
    password: 'short7',
    confirm: 'short7',
  });
  assert.match(shortPassword, new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`));
  assert.equal(MIN_PASSWORD_LENGTH, 8);
});

test('validateRegistration rejects mismatched confirmation', () => {
  const result = validateRegistration({
    first_name: 'R',
    last_name: 'V',
    email: 'r@example.com',
    password: 'super-secret-1',
    confirm: 'super-secret-2',
  });
  assert.match(result, /do not match/);
});

test('validateRegistration tolerates non-string junk inputs', () => {
  const result = validateRegistration({
    first_name: 42,
    last_name: null,
    email: undefined,
    password: {},
    confirm: [],
  });
  assert.match(result, /enter your first name/);
});
