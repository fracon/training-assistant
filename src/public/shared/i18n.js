import { updateLanguagePreference } from './api.js';

export const SUPPORTED_LANGUAGES = ['en-US', 'pt-BR'];
export const DEFAULT_LANGUAGE = 'en-US';

const STORAGE_KEY = 'training-assistant:lang';
const FILE_BY_LANGUAGE = { 'en-US': 'en', 'pt-BR': 'pt' };

function isSupported(value) {
  return SUPPORTED_LANGUAGES.includes(value);
}

export function normalizeClientLanguage(...candidates) {
  for (const candidate of candidates) {
    if (isSupported(candidate)) return candidate;
  }
  return DEFAULT_LANGUAGE;
}

export function readStoredLanguage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveStoredLanguage(lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable - the in-memory language still applies */
  }
}

export function syncStoredLanguageFromUser(user) {
  if (!user || !isSupported(user.preferred_lang)) return false;
  saveStoredLanguage(user.preferred_lang);
  return true;
}

export async function loadMessages(lang) {
  const file = FILE_BY_LANGUAGE[lang] ?? FILE_BY_LANGUAGE[DEFAULT_LANGUAGE];
  const response = await fetch(`/locales/${file}.json`);
  if (!response.ok) {
    throw new Error(`Locale file not found: ${file}.json`);
  }
  return response.json();
}

export function translate(messages, key, params) {
  let value = key
    .split('.')
    .reduce((acc, part) => (acc == null ? acc : acc[part]), messages);
  if (typeof value !== 'string') return key;
  if (params) {
    value = value.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    );
  }
  return value;
}

export function applyTranslations(root, messages) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = translate(messages, el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = translate(messages, el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', translate(messages, el.dataset.i18nAriaLabel));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = translate(messages, el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = translate(messages, el.dataset.i18nHtml);
  });
}

function markActiveLanguage(lang) {
  document
    .querySelectorAll('.lang-switch [data-lang]')
    .forEach((button) => button.classList.toggle('active', button.dataset.lang === lang));
}

const SERVER_ERROR_KEYS = [
  ['Invalid email or password.', 'errors.invalidCredentials'],
  ['Email and password are required.', 'errors.missingBoth'],
  ['This email is already registered.', 'errors.emailTaken'],
  ['Network unavailable. Please try again.', 'errors.network'],
  ['Something went wrong. Please try again.', 'errors.generic'],
];

export function translateApiError(message, t) {
  for (const [raw, key] of SERVER_ERROR_KEYS) {
    if (message === raw) return t(key);
  }
  return message;
}

export function createI18n({ persistPreference = false, onChange } = {}) {
  let language = DEFAULT_LANGUAGE;
  let messages = {};

  const t = (key, params) => translate(messages, key, params);

  async function apply(lang) {
    language = lang;
    saveStoredLanguage(lang);
    messages = await loadMessages(lang);
    document.documentElement.lang = lang;
    applyTranslations(document, messages);
    markActiveLanguage(lang);
  }

  async function init(preferredFromUser) {
    await apply(normalizeClientLanguage(preferredFromUser, readStoredLanguage()));
    if (onChange) onChange();
    return language;
  }

  async function setLanguage(next) {
    if (!isSupported(next) || next === language) return language;
    saveStoredLanguage(next);
    if (persistPreference) {
      try {
        await updateLanguagePreference(next);
      } catch {
        /* offline - keep going with the local preference */
      }
    }
    await apply(next);
    if (onChange) onChange();
    return language;
  }

  return {
    init,
    setLanguage,
    t,
    get language() {
      return language;
    },
    get messages() {
      return messages;
    },
  };
}

export function wireLanguageSwitcher(i18n) {
  document.querySelectorAll('.lang-switch [data-lang]').forEach((button) => {
    button.addEventListener('click', () => i18n.setLanguage(button.dataset.lang));
  });
}
