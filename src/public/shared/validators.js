export const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(text(value));
}

export function validateLogin(input) {
  const email = text(input && input.email);
  const password = typeof (input && input.password) === 'string' ? input.password : '';
  if (!email || !password) {
    return 'Please fill in your email and password.';
  }
  if (!isValidEmail(email)) {
    return 'Please enter a valid email address.';
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
    errors.push('Please enter your first name.');
    invalid.first_name = true;
  }
  if (!lastName) {
    errors.push('Please enter your last name.');
    invalid.last_name = true;
  }
  if (!email) {
    errors.push('Please enter your email.');
    invalid.email = true;
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.push('Please enter a valid email address.');
    invalid.email = true;
  }
  if (!password) {
    errors.push('Please choose a password.');
    invalid.password = true;
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
    invalid.password = true;
  }
  if (!confirm) {
    errors.push('Please confirm your password.');
    invalid.confirm = true;
  } else if (password && confirm !== password) {
    errors.push('Passwords do not match.');
    invalid.confirm = true;
  }

  return { valid: errors.length === 0, errors, invalid };
}
