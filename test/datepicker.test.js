'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');

test('central DatePicker keeps ISO dates stable and rejects invalid calendar dates', async () => {
  const { dateFromIso, isoFromDate } = await import('../src/public/shared/datepicker.js');
  assert.equal(isoFromDate(dateFromIso('2026-09-14')), '2026-09-14');
  assert.equal(dateFromIso('2026-02-30'), null);
  assert.equal(dateFromIso(''), null);
});

test('central DatePicker defines localized display, language reactivity and week-start rendering', () => {
  const js = readFileSync(join(publicDir, 'shared', 'datepicker.js'), 'utf8');
  assert.match(js, /formatDate\(iso, getLanguage\(\)\)/);
  assert.match(js, /document\.addEventListener\('app:languagechange', render\)/);
  assert.match(js, /document\.addEventListener\('kinesis:preferences-changed', render\)/);
  assert.match(js, /firstDayIndex\(getWeekStart\(\)\)/);
  assert.match(js, /data-lucide="calendar"/);
  assert.match(js, /locale === 'pt-BR' \? 'Mês anterior' : 'Previous month'/);
  assert.match(js, /date-picker-popup/);
});

test('all application date entry points use the centralized picker', () => {
  const cycles = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  const coach = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');
  assert.match(cycles, /createDatePicker\(document\.getElementById\(id\)/);
  assert.match(coach, /createDatePicker\(targetDateDisplay/);
});
