'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SUPPORTED_DISTANCE_UNITS,
  DEFAULT_DISTANCE_UNIT,
  SUPPORTED_TEMPERATURE_UNITS,
  DEFAULT_TEMPERATURE_UNIT,
  normalizeDistanceUnit,
  normalizeTemperatureUnit,
  isSupportedDistanceUnit,
  isSupportedTemperatureUnit,
} = require('../src/auth/preferences');

test('preference units expose stable defaults', () => {
  assert.deepEqual(SUPPORTED_DISTANCE_UNITS, ['km', 'mi']);
  assert.equal(DEFAULT_DISTANCE_UNIT, 'km');
  assert.deepEqual(SUPPORTED_TEMPERATURE_UNITS, ['C', 'F']);
  assert.equal(DEFAULT_TEMPERATURE_UNIT, 'C');
});

test('preference units normalize case and whitespace', () => {
  assert.equal(normalizeDistanceUnit(' MI '), 'mi');
  assert.equal(normalizeTemperatureUnit(' f '), 'F');
  assert.equal(isSupportedDistanceUnit('KM'), true);
  assert.equal(isSupportedTemperatureUnit('c'), true);
});

test('preference units fall back and reject unsupported values', () => {
  for (const value of [undefined, null, '', 'yards', 42]) {
    assert.equal(normalizeDistanceUnit(value), 'km');
    assert.equal(normalizeTemperatureUnit(value), 'C');
    assert.equal(isSupportedDistanceUnit(value), false);
    assert.equal(isSupportedTemperatureUnit(value), false);
  }
});
