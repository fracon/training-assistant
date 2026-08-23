'use strict';

const SUPPORTED_LANGUAGES = ['en-US', 'pt-BR'];
const DEFAULT_LANGUAGE = 'en-US';

function normalizeLanguage(value) {
  if (typeof value !== 'string') {
    return DEFAULT_LANGUAGE;
  }
  const candidate = value.trim();
  const match = SUPPORTED_LANGUAGES.find(
    (language) => language.toLowerCase() === candidate.toLowerCase()
  );
  return match ?? DEFAULT_LANGUAGE;
}

function isSupportedLanguage(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const candidate = value.trim().toLowerCase();
  return SUPPORTED_LANGUAGES.some(
    (language) => language.toLowerCase() === candidate
  );
}

module.exports = {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  isSupportedLanguage,
};
