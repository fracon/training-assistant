import { validateRegistration } from './shared/validators.js';
import { currentUser, registerAccount, signIn } from './shared/api.js';

const $ = (id) => document.getElementById(id);

const FIELD_IDS = {
  first_name: 'firstName',
  last_name: 'lastName',
  email: 'email',
  password: 'password',
  confirm: 'confirm',
};

const TOAST_DURATION_MS = 2800;
const REDIRECT_DELAY_MS = 900;

const form = $('registerForm');
const errorBox = $('formErrors');
const errorList = $('errorList');
const submitBtn = $('submitBtn');

let toastTimer = null;

function showToast(message) {
  $('toastMessage').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), TOAST_DURATION_MS);
}

function clearErrors() {
  errorBox.classList.add('hidden');
  errorList.innerHTML = '';
  Object.values(FIELD_IDS).forEach((id) => $(id).classList.remove('input-error'));
}

function showErrors(errors, invalid) {
  errorList.innerHTML = '';
  errors.forEach((message) => {
    const item = document.createElement('li');
    item.textContent = message;
    errorList.appendChild(item);
  });
  Object.keys(invalid).forEach((field) => {
    $(FIELD_IDS[field]).classList.add('input-error');
  });
  errorBox.classList.remove('hidden');
}

function setBusy(isBusy) {
  submitBtn.disabled = isBusy;
  submitBtn.textContent = isBusy ? 'Creating Account…' : 'Create Account';
}

function collectPayload() {
  return {
    first_name: $('firstName').value,
    last_name: $('lastName').value,
    email: $('email').value,
    password: $('password').value,
    confirm: $('confirm').value,
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const payload = collectPayload();
  clearErrors();

  const validation = validateRegistration(payload);
  if (!validation.valid) {
    showErrors(validation.errors, validation.invalid);
    return;
  }

  setBusy(true);
  try {
    await registerAccount(payload);
    try {
      await signIn(payload.email.trim(), payload.password);
      showToast('Account created successfully! Welcome.');
      setTimeout(() => window.location.replace('/'), REDIRECT_DELAY_MS);
    } catch {
      window.location.replace('/login.html?registered=1');
    }
  } catch (error) {
    showErrors([error.message], {});
    setBusy(false);
  }
});

Object.values(FIELD_IDS).forEach((id) => {
  $(id).addEventListener('input', () => $(id).classList.remove('input-error'));
});

currentUser().then((user) => {
  if (user) {
    window.location.replace('/');
  }
});
