import { validateLogin } from './shared/validators.js';
import { currentUser, signIn } from './shared/api.js';

const $ = (id) => document.getElementById(id);

const form = $('loginForm');
const errorEl = $('formError');
const submitBtn = $('submitBtn');

function setMessage(message, tone = '') {
  errorEl.textContent = message;
  errorEl.dataset.tone = tone;
}

function setBusy(isBusy) {
  submitBtn.disabled = isBusy;
  submitBtn.textContent = isBusy ? 'Signing In…' : 'Sign In';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('email').value;
  const password = $('password').value;

  const validationError = validateLogin({ email, password });
  if (validationError) {
    setMessage(validationError);
    return;
  }

  setMessage('');
  setBusy(true);
  try {
    await signIn(email.trim(), password);
    window.location.replace('/');
  } catch (error) {
    setMessage(error.message);
    setBusy(false);
  }
});

const params = new URLSearchParams(window.location.search);
if (params.get('registered') === '1') {
  setMessage('Account created! Sign in to continue.', 'ok');
}

currentUser().then((user) => {
  if (user) {
    window.location.replace('/');
  }
});
