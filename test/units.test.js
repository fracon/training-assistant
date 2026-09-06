'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const units = require('../src/public/shared/units.js');

test('distance conversion and formatting support metric and imperial units', () => {
  assert.equal(units.convertDistanceFromKm(5, 'km'), 5);
  assert.equal(units.convertDistanceFromKm(5, 'mi'), 3.106855);
  assert.equal(units.formatDistance(5, 'km'), '5.00 km');
  assert.equal(units.formatDistance(5, 'mi'), '3.11 mi');
  assert.equal(units.formatDistance('bad', 'mi'), '0.00 mi');
});

test('temperature conversion and formatting support Celsius and Fahrenheit', () => {
  assert.equal(units.convertCelsius(25, 'C'), 25);
  assert.equal(units.convertCelsius(25, 'F'), 77);
  assert.equal(units.formatTemperature(25, 'C'), '25 °C');
  assert.equal(units.formatTemperature(25, 'F'), '77 °F');
  assert.equal(units.formatTemperature('bad', 'F'), '0 °F');
});

test('unit labels normalize unsupported preferences to metric defaults', () => {
  assert.equal(units.normalizeDistanceUnit('yards'), 'km');
  assert.equal(units.normalizeTemperatureUnit('K'), 'C');
  assert.equal(units.distancePromptUnit('yards'), 'km');
  assert.equal(units.distancePromptUnit('mi'), 'miles');
  assert.equal(units.temperaturePromptUnit('K'), '°C');
  assert.equal(units.temperaturePromptUnit('F'), '°F');
});
