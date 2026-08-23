'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, verifyPassword } = require('../src/auth/passwords');

test('hashPassword produces a salted scrypt hash in the documented format', async () => {
  const stored = await hashPassword('correct horse battery staple');

  const [scheme, saltHex, keyHex] = stored.split('$');
  assert.equal(scheme, 'scrypt');
  assert.equal(saltHex.length, 32);
  assert.equal(keyHex.length, 128);
  assert.match(saltHex, /^[0-9a-f]+$/);
  assert.match(keyHex, /^[0-9a-f]+$/);
  assert.ok(!stored.includes('correct horse battery staple'));
});

test('hashPassword generates a unique salt for every call', async () => {
  const first = await hashPassword('same-password');
  const second = await hashPassword('same-password');
  assert.notEqual(first, second);
});

test('verifyPassword accepts the correct password and rejects a wrong one', async () => {
  const stored = await hashPassword('my-secret-123');

  assert.equal(await verifyPassword('my-secret-123', stored), true);
  assert.equal(await verifyPassword('wrong-secret-456', stored), false);
});

test('verifyPassword rejects malformed or unsupported stored hashes', async () => {
  const stored = await hashPassword('some-password');
  const [, saltHex, keyHex] = stored.split('$');

  assert.equal(await verifyPassword('any', ''), false);
  assert.equal(
    await verifyPassword('any', `bcrypt$${saltHex}$${keyHex}`),
    false
  );
  assert.equal(await verifyPassword('any', `scrypt$$${keyHex}`), false);
  assert.equal(await verifyPassword('any', `scrypt$${saltHex}$`), false);
});
