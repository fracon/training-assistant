export const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(text(value));
}

export function validatePasswordChange(input) {
  const fields = input ?? {};
  const errors = [];
  const invalid = {};

  const current = typeof fields.currentPassword === 'string' ? fields.currentPassword : '';
  const next = typeof fields.newPassword === 'string' ? fields.newPassword : '';
  const confirm = typeof fields.confirmNewPassword === 'string' ? fields.confirmNewPassword : '';

  if (!current) {
    errors.push('currentRequired');
    invalid.current = true;
  }
  if (!next) {
    errors.push('newRequired');
    invalid.next = true;
  } else if (next.length < MIN_PASSWORD_LENGTH) {
    errors.push('passwordMinLength');
    invalid.next = true;
  }
  if (!confirm) {
    errors.push('confirmRequired');
    invalid.confirm = true;
  } else if (next && confirm !== next) {
    errors.push('passwordsMismatch');
    invalid.confirm = true;
  }
  if (next && next === current) {
    errors.push('sameAsCurrent');
    invalid.next = true;
  }

  return { valid: errors.length === 0, errors, invalid };
}

export function validateLogin(input) {
  const email = text(input && input.email);
  const password = typeof (input && input.password) === 'string' ? input.password : '';
  if (!email || !password) {
    return 'errors.fillBoth';
  }
  if (!isValidEmail(email)) {
    return 'errors.invalidEmail';
  }
  return '';
}

export function validateRegistration(input) {
  const fields = input ?? {};
  const errors = [];
  const invalid = {};

  const firstName = text(fields.first_name);
  const lastName = text(fields.last_name);
  const email = text(fields.email);
  const password = typeof fields.password === 'string' ? fields.password : '';
  const confirm = typeof fields.confirm === 'string' ? fields.confirm : '';

  if (!firstName) {
    errors.push('errors.firstNameRequired');
    invalid.first_name = true;
  }
  if (!lastName) {
    errors.push('errors.lastNameRequired');
    invalid.last_name = true;
  }
  if (!email) {
    errors.push('errors.emailRequired');
    invalid.email = true;
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.push('errors.invalidEmail');
    invalid.email = true;
  }
  if (!password) {
    errors.push('errors.choosePassword');
    invalid.password = true;
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push('errors.passwordMin');
    invalid.password = true;
  }
  if (!confirm) {
    errors.push('errors.confirmRequired');
    invalid.confirm = true;
  } else if (password && confirm !== password) {
    errors.push('errors.mismatch');
    invalid.confirm = true;
  }

  return { valid: errors.length === 0, errors, invalid };
}
