import { validateLogin } from './shared/validators.js';
import { currentUser, signIn } from './shared/api.js';
import {
  createI18n,
  wireLanguageSwitcher,
  translateApiError,
  syncStoredLanguageFromUser,
} from './shared/i18n.js';

const $ = (id) => document.getElementById(id);

const form = $('loginForm');
const errorEl = $('formError');
const submitBtn = $('submitBtn');

const i18n = createI18n();
wireLanguageSwitcher(i18n);

function setMessage(message, tone = '') {
  errorEl.textContent = message;
  errorEl.dataset.tone = tone;
}

function setBusy(isBusy) {
  submitBtn.disabled = isBusy;
  submitBtn.textContent = isBusy ? i18n.t('login.submitting') : i18n.t('login.submit');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('email').value;
  const password = $('password').value;

  const validationError = validateLogin({ email, password });
  if (validationError) {
    setMessage(i18n.t(validationError));
    return;
  }

  setMessage('');
  setBusy(true);
  try {
    const payload = await signIn(email.trim(), password);
    syncStoredLanguageFromUser(payload?.user);
    window.location.replace('/');
  } catch (error) {
    setMessage(translateApiError(error.message, i18n.t));
    setBusy(false);
  }
});

await i18n.init();
setBusy(false);

const params = new URLSearchParams(window.location.search);
if (params.get('registered') === '1') {
  setMessage(i18n.t('login.registeredBanner'), 'ok');
}

currentUser().then((user) => {
  if (user) {
    window.location.replace('/');
  }
});
