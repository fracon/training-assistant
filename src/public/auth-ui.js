(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AuthUI = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_PASSWORD_LENGTH = 8;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function isValidEmail(value) {
    return EMAIL_PATTERN.test(text(value));
  }

  function validateLogin(input) {
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

  function validateRegistration(input) {
    const fields = input ?? {};
    const missing = [
      ['first_name', 'first name'],
      ['last_name', 'last name'],
      ['email', 'email'],
    ].find(([key]) => !text(fields[key]));

    if (missing) {
      return `Please enter your ${missing[1]}.`;
    }

    const password = typeof fields.password === 'string' ? fields.password : '';
    if (!password) {
      return 'Please choose a password.';
    }

    if (!isValidEmail(fields.email)) {
      return 'Please enter a valid email address.';
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
    }

    if (fields.confirm !== password) {
      return 'Passwords do not match.';
    }

    return '';
  }

  return { isValidEmail, validateLogin, validateRegistration, MIN_PASSWORD_LENGTH };
});
