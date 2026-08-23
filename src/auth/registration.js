'use strict';

const { hashPassword } = require('./passwords');
const { normalizeLanguage } = require('./language');

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUIRED_FIELDS = ['email', 'password', 'first_name', 'last_name'];

class RegistrationError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RegistrationError';
    this.status = status;
  }
}

function normalizeRegistration(payload) {
  const body = payload ?? {};
  const field = (value) => (typeof value === 'string' ? value.trim() : '');

  return {
    email: field(body.email).toLowerCase(),
    password: typeof body.password === 'string' ? body.password : '',
    first_name: field(body.first_name),
    last_name: field(body.last_name),
    preferred_lang: normalizeLanguage(body.preferred_lang),
  };
}

function validateRegistration(registration) {
  const missing = REQUIRED_FIELDS.filter((name) => registration[name] === '');
  if (missing.length > 0) {
    throw new RegistrationError(400, `Missing required fields: ${missing.join(', ')}.`);
  }
  if (!EMAIL_PATTERN.test(registration.email)) {
    throw new RegistrationError(400, 'Invalid email address.');
  }
  if (registration.password.length < MIN_PASSWORD_LENGTH) {
    throw new RegistrationError(
      400,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`
    );
  }
}

async function registerUser(db, payload) {
  const registration = normalizeRegistration(payload);
  validateRegistration(registration);

  const existing = db
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(registration.email);
  if (existing) {
    throw new RegistrationError(409, 'This email is already registered.');
  }

  const passwordHash = await hashPassword(registration.password);
  const result = db
    .prepare(
      `INSERT INTO users (email, password_hash, first_name, last_name, preferred_lang)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      registration.email,
      passwordHash,
      registration.first_name,
      registration.last_name,
      registration.preferred_lang
    );

  return {
    id: Number(result.lastInsertRowid),
    email: registration.email,
    first_name: registration.first_name,
    last_name: registration.last_name,
    preferred_lang: registration.preferred_lang,
  };
}

module.exports = { registerUser, validateRegistration, normalizeRegistration, RegistrationError };
