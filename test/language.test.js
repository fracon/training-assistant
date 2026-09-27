'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  isSupportedLanguage,
} = require('../src/auth/language');

test('language constants list both supported locales with en-US default', () => {
  assert.deepEqual(SUPPORTED_LANGUAGES, ['en-US', 'pt-BR']);
  assert.equal(DEFAULT_LANGUAGE, 'en-US');
});

test('normalizeLanguage canonicalizes supported values case-insensitively', () => {
  assert.equal(normalizeLanguage('en-US'), 'en-US');
  assert.equal(normalizeLanguage('pt-BR'), 'pt-BR');
  assert.equal(normalizeLanguage('PT-br'), 'pt-BR');
  assert.equal(normalizeLanguage('  En-us  '), 'en-US');
});

test('normalizeLanguage falls back to the default for junk inputs', () => {
  assert.equal(normalizeLanguage(undefined), 'en-US');
  assert.equal(normalizeLanguage(null), 'en-US');
  assert.equal(normalizeLanguage(42), 'en-US');
  assert.equal(normalizeLanguage('fr-FR'), 'en-US');
  assert.equal(normalizeLanguage(''), 'en-US');
});

test('isSupportedLanguage accepts only the two supported tags', () => {
  assert.equal(isSupportedLanguage('en-US'), true);
  assert.equal(isSupportedLanguage('pt-BR'), true);
  assert.equal(isSupportedLanguage(' pt-br '), true);
  assert.equal(isSupportedLanguage('fr-FR'), false);
  assert.equal(isSupportedLanguage(''), false);
  assert.equal(isSupportedLanguage(undefined), false);
  assert.equal(isSupportedLanguage(null), false);
  assert.equal(isSupportedLanguage(42), false);
});

test('translateApiError prefers a stable server code in both languages', async () => {
  const { translateApiError } = await import('../src/public/shared/i18n.js');
  const locales = {
    'en-US': JSON.parse(readFileSync(join(__dirname, '..', 'src', 'public', 'locales', 'en.json'), 'utf8')),
    'pt-BR': JSON.parse(readFileSync(join(__dirname, '..', 'src', 'public', 'locales', 'pt.json'), 'utf8')),
  };
  const t = (messages, key, params) => {
    const value = String(key).split('.').reduce((node, part) => (node ? node[part] : undefined), messages);
    return typeof value === 'string' && !params
      ? value
      : (value ?? key);
  };

  const inactive = Object.assign(new Error('Your account is inactive. Please contact the administrator.'), {
    codes: ['accountInactive'],
  });
  assert.equal(translateApiError(inactive, (key) => t(locales['en-US'], key)),
    'This account is inactive. Ask an administrator to activate it.');
  assert.equal(translateApiError(inactive, (key) => t(locales['pt-BR'], key)),
    'Esta conta está inativa. Peça a um administrador para ativá-la.');

  // A bare message keeps the older prose mapping, and an unmapped failure keeps
  // its own text, exactly as before the code was introduced.
  const english = (key) => t(locales['en-US'], key);
  assert.equal(translateApiError('Invalid email or password.', english), 'Invalid email or password.');
  assert.equal(translateApiError(new Error('Invalid email or password.'), english),
    'Invalid email or password.');
  assert.equal(translateApiError(new Error('Email and password are required.'), english),
    'Email and password are required.');
  const unknownCode = Object.assign(new Error('Some internal detail'), { codes: ['somethingElse'] });
  assert.equal(translateApiError(unknownCode, english), 'Some internal detail');
  assert.equal(translateApiError(undefined, english), undefined);
});
