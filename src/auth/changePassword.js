'use strict';

const { verifyPassword, hashPassword } = require('./passwords');

const MIN_PASSWORD_LENGTH = 8;

class ChangePasswordError extends Error {
  constructor(status, message, errors = []) {
    super(message);
    this.name = 'ChangePasswordError';
    this.status = status;
    this.errors = errors;
  }
}

function normalizePasswordChange(payload) {
  const body = payload ?? {};
  return {
    currentPassword: typeof body.currentPassword === 'string' ? body.currentPassword : '',
    newPassword: typeof body.newPassword === 'string' ? body.newPassword : '',
    confirmNewPassword:
      typeof body.confirmNewPassword === 'string' ? body.confirmNewPassword : '',
  };
}

function validatePasswordChange(change) {
  const errors = [];
  if (!change.currentPassword) {
    errors.push('currentRequired');
  }
  if (!change.newPassword) {
    errors.push('newRequired');
  } else if (change.newPassword.length < MIN_PASSWORD_LENGTH) {
    errors.push('passwordMinLength');
  }
  if (!change.confirmNewPassword) {
    errors.push('confirmRequired');
  } else if (change.newPassword && change.newPassword !== change.confirmNewPassword) {
    errors.push('passwordsMismatch');
  }
  if (change.newPassword && change.newPassword === change.currentPassword) {
    errors.push('sameAsCurrent');
  }
  return errors;
}

async function changePassword(db, userId, payload) {
  const change = normalizePasswordChange(payload);
  const errors = validatePasswordChange(change);
  if (errors.length > 0) {
    throw new ChangePasswordError(400, 'Invalid password change request.', errors);
  }

  const row = db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(userId);
  if (!row) {
    throw new ChangePasswordError(404, 'User not found.', ['userNotFound']);
  }

  const isValid = await verifyPassword(change.currentPassword, row.password_hash);
  if (!isValid) {
    throw new ChangePasswordError(401, 'Incorrect current password.', [
      'incorrectCurrentPassword',
    ]);
  }

  const passwordHash = await hashPassword(change.newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    passwordHash,
    userId
  );

  return { status: 'ok' };
}

module.exports = {
  changePassword,
  normalizePasswordChange,
  validatePasswordChange,
  ChangePasswordError,
  MIN_PASSWORD_LENGTH,
};