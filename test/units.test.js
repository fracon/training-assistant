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

test('distance input conversion preserves a valid value while retaining blank and invalid edits', () => {
  assert.equal(units.convertDistanceInputValue(10, 'km', 'mi'), 6.214);
  assert.equal(units.convertDistanceInputValue(6.214, 'mi', 'km'), 10);
  assert.equal(units.convertDistanceInputValue(12.3456, 'km', 'km'), 12.346);
  assert.equal(units.convertDistanceInputValue('', 'km', 'mi'), null);
  assert.equal(units.convertDistanceInputValue('not-ready', 'km', 'mi'), null);
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

test('body measurements convert between metric storage and the imperial preference', async () => {
  const units = await import('../src/public/shared/units.js');
  assert.equal(units.normalizeBodyUnit('imperial'), 'imperial');
  assert.equal(units.normalizeBodyUnit('anything'), 'metric');
  assert.equal(units.weightFromKg(70, 'metric'), 70);
  assert.ok(Math.abs(units.weightFromKg(70, 'imperial') - 154.32) < 0.01);
  assert.equal(units.weightFromKg('x', 'metric'), null);
  assert.ok(Math.abs(units.weightToKg('154.32', 'imperial') - 70) < 0.01);
  assert.equal(units.weightToKg('72.5', 'metric'), 72.5);
  assert.equal(units.weightToKg('', 'metric'), null);
  assert.equal(units.weightToKg('abc', 'metric'), null);
  assert.equal(units.formatWeight(72.44, 'metric'), '72.4 kg');
  assert.equal(units.formatWeight(70, 'imperial'), '154.3 lb');
  assert.equal(units.formatWeight(null, 'metric'), '');
  assert.equal(units.weightUnitLabel('imperial'), 'lb');
  assert.deepEqual(units.heightFromCm(178, 'metric'), { cm: 178 });
  assert.deepEqual(units.heightFromCm(177.8, 'imperial'), { feet: 5, inches: 10 });
  assert.equal(units.heightFromCm('x', 'imperial'), null);
  assert.equal(units.heightToCm({ cm: '178' }, 'metric'), 178);
  assert.equal(units.heightToCm({ cm: '' }, 'metric'), null);
  assert.equal(units.heightToCm({ cm: 'abc' }, 'metric'), null);
  assert.ok(Math.abs(units.heightToCm({ feet: '5', inches: '10' }, 'imperial') - 177.8) < 0.001);
  assert.ok(Math.abs(units.heightToCm({ feet: '6', inches: '' }, 'imperial') - 182.88) < 0.001);
  assert.equal(units.heightToCm({ feet: '', inches: '4' }, 'imperial'), null);
  assert.equal(units.heightToCm({ feet: '5', inches: 'x' }, 'imperial'), null);
  assert.equal(units.formatHeight(177.8, 'imperial'), '5 ft 10 in');
  assert.equal(units.formatHeight(178, 'metric'), '178 cm');
  assert.equal(units.formatHeight(undefined, 'metric'), '');
});
