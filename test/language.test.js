'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
