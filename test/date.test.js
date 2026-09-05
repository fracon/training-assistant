'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { dateLocale, formatDate, formatWeekday } = require('../src/public/shared/date.js');

test('dateLocale resolves supported locale families and defaults to English', () => {
  assert.equal(dateLocale('pt-BR'), 'pt-BR');
  assert.equal(dateLocale('pt'), 'pt-BR');
  assert.equal(dateLocale('en-US'), 'en-US');
  assert.equal(dateLocale('fr-FR'), 'en-US');
  assert.equal(dateLocale(undefined), 'en-US');
});

test('formatDate follows the application date standard for Portuguese and English', () => {
  assert.equal(formatDate('2026-09-05', 'pt-BR'), '05/09/2026');
  assert.equal(formatDate('2026-09-05', 'en-US'), '09/05/2026');
  assert.equal(formatDate(new Date(2026, 8, 5), 'pt'), '05/09/2026');
});

test('formatDate rejects invalid or impossible dates', () => {
  assert.equal(formatDate('2026-02-30', 'pt-BR'), '');
  assert.equal(formatDate('not-a-date', 'en-US'), '');
  assert.equal(formatDate(null, 'en-US'), '');
});

test('formatWeekday follows the active locale and rejects invalid values', () => {
  assert.equal(formatWeekday('2026-09-05', 'pt-BR'), 'sábado');
  assert.equal(formatWeekday('2026-09-05', 'en-US'), 'Saturday');
  assert.equal(formatWeekday('junk', 'pt-BR'), '');
});

