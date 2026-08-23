'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const SCHEME = 'scrypt';
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH);
  return `${SCHEME}$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [scheme, saltHex, keyHex] = String(storedHash).split('$');
  if (scheme !== SCHEME || !saltHex || !keyHex) {
    return false;
  }
  const expectedKey = Buffer.from(keyHex, 'hex');
  const derivedKey = await scrypt(password, Buffer.from(saltHex, 'hex'), expectedKey.length);
  return crypto.timingSafeEqual(derivedKey, expectedKey);
}

module.exports = { hashPassword, verifyPassword };
