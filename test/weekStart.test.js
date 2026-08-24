'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SUPPORTED_WEEK_STARTS,
  DEFAULT_WEEK_START,
  normalizeWeekStart,
  isSupportedWeekStart,
} = require('../src/auth/weekStart');

test('week start constants match the phase specification', () => {
  assert.deepEqual(SUPPORTED_WEEK_STARTS, ['Monday', 'Sunday']);
  assert.equal(DEFAULT_WEEK_START, 'Monday');
});

test('normalizeWeekStart canonicalizes casing and whitespace', () => {
  assert.equal(normalizeWeekStart(' monday '), 'Monday');
  assert.equal(normalizeWeekStart('SUNDAY'), 'Sunday');
  assert.equal(normalizeWeekStart('SuNdAy'), 'Sunday');
});

test('normalizeWeekStart falls back to Monday for junk input', () => {
  for (const junk of ['Funday', '', 'mon', null, undefined, 42, {}]) {
    assert.equal(normalizeWeekStart(junk), 'Monday', String(junk));
  }
});

test('isSupportedWeekStart is strict about the stored value', () => {
  assert.equal(isSupportedWeekStart('Monday'), true);
  assert.equal(isSupportedWeekStart(' sunday '), true);
  assert.equal(isSupportedWeekStart('Tuesday'), false);
  assert.equal(isSupportedWeekStart(''), false);
  assert.equal(isSupportedWeekStart(null), false);
  assert.equal(isSupportedWeekStart(7), false);
});
