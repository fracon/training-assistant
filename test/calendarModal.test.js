'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');

const { importErrorEntries } = require('../src/public/calendar.js');

test('import modal markup ships hidden so it can never render on page load', () => {
  const html = readFileSync(join(publicDir, 'calendar.html'), 'utf8');
  const match = html.match(/<div id="importModal" class="([^"]*)"/);
  assert.ok(match, 'importModal element exists in the markup');
  const classes = match[1].split(/\s+/);
  assert.ok(classes.includes('hidden'), 'hidden class hardcoded in the HTML');
});

test('calendar.css guarantees the hidden state wins over the backdrop display', () => {
  const css = readFileSync(join(publicDir, 'calendar.css'), 'utf8');
  const backdropIndex = css.indexOf('.modal-backdrop {');
  const overrideMatch = css.match(/\.modal-backdrop\.hidden\s*\{[^}]*display:\s*none[^}]*\}/);
  assert.ok(backdropIndex !== -1, 'backdrop display rule exists');
  assert.ok(overrideMatch, '.modal-backdrop.hidden forces display:none');
  assert.ok(
    css.indexOf(overrideMatch[0]) > backdropIndex,
    'override is defined after the backdrop rule'
  );
});

test('modal logic is isolated to the file-input catch handler', () => {
  const js = readFileSync(join(publicDir, 'calendar.js'), 'utf8');
  const occurrences = js.split('showImportErrors').length - 1;
  assert.equal(
    occurrences,
    2,
    'showImportErrors appears only as its definition plus one call site'
  );
  const reloadStart = js.indexOf('async function reloadTrainings');
  const reloadEnd = js.indexOf('async function handleImportSelection');
  const reloadBody = js.slice(reloadStart, reloadEnd);
  assert.ok(!reloadBody.includes('showImportErrors'));
  assert.ok(!reloadBody.includes('importModal'));

  const startStart = js.indexOf('start(user)');
  const startEnd = js.indexOf('export async function initCalendar');
  const startBody = js.slice(startStart, startEnd);
  assert.ok(!startBody.includes('showImportErrors'));
});

test('importErrorEntries passes real row errors straight through', () => {
  const rowErrors = [
    { row: 3, col: 'Dia', error: 'Required value is empty.' },
    { row: 4, col: 'Tipo', error: 'Required value is empty.' },
  ];
  assert.equal(importErrorEntries({ rowErrors }), rowErrors);
});

test('importErrorEntries falls back to a generic entry for plain failures', () => {
  assert.deepEqual(importErrorEntries(new Error('Network unavailable.')), [
    { row: '—', col: '—', error: 'Network unavailable.' },
  ]);
});

test('importErrorEntries refuses to open the modal without details', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(importErrorEntries(undefined), null);
    assert.equal(importErrorEntries(null), null);
    assert.equal(importErrorEntries({}), null);
    assert.equal(importErrorEntries({ rowErrors: [] }), null);
    assert.equal(importErrorEntries(new Error()), null, 'error without a message');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0, 'guard stays silent at the pure layer');
});
