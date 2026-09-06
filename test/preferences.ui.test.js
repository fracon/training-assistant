'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const shared = join(__dirname, '..', 'src', 'public', 'shared');

test('shell exposes the preferences menu trigger and standardized modal', () => {
  const js = readFileSync(join(shared, 'shell.js'), 'utf8');
  const css = readFileSync(join(shared, 'shell.css'), 'utf8');
  assert.match(js, /preferences\.id = 'userPreferences'/);
  assert.match(js, /preferences\.appendChild\(icon\('settings'\)\)/);
  assert.match(js, /data-i18n', 'shell\.preferences'/);
  assert.match(js, /export function openPreferencesModal/);
  assert.match(js, /password-modal-backdrop preferences-modal-backdrop/);
  assert.match(js, /modal-card password-modal-card preferences-modal-card/);
  assert.match(js, /id = 'preferencesForm'/);
  assert.match(js, /first_day_of_week/);
  assert.match(js, /distance_unit/);
  assert.match(js, /temperature_unit/);
  assert.match(js, /getElementById\('userPreferences'\)\.addEventListener\('click'/);
  assert.match(css, /\.preferences-modal-card/);
  assert.match(css, /\.preference-choice/);
});

test('preference locale keys are available in both dictionaries', () => {
  const en = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'public', 'locales', 'en.json'), 'utf8'));
  const pt = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'public', 'locales', 'pt.json'), 'utf8'));
  for (const messages of [en, pt]) {
    assert.equal(typeof messages.shell.preferences, 'string');
    assert.equal(typeof messages.preferences.title, 'string');
    assert.equal(typeof messages.preferences.firstDay.monday, 'string');
    assert.equal(typeof messages.preferences.firstDay.sunday, 'string');
    assert.equal(typeof messages.preferences.distance.km, 'string');
    assert.equal(typeof messages.preferences.distance.mi, 'string');
    assert.equal(typeof messages.preferences.temperature.celsius, 'string');
    assert.equal(typeof messages.preferences.temperature.fahrenheit, 'string');
  }
});
