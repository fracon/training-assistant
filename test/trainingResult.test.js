'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');

const {
  resolveSessionId,
  formatDateLabel,
  plannedValue,
  normalizeFeedbackRpe,
} = require('../src/public/training-result.js');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

test('resolveSessionId extracts the contextual id from the query string', () => {
  assert.equal(resolveSessionId('?id=42'), '42');
  assert.equal(resolveSessionId('?id=%20%207%20'), '7', 'surrounding whitespace is trimmed');
});

test('resolveSessionId bounces to the calendar when no id is present', () => {
  for (const search of ['', '?', '?other=1', '?id=', '?id=%20%20']) {
    assert.equal(resolveSessionId(search), null, `search=${search || '<empty>'}`);
  }
});

test('formatDateLabel renders DD/MM/YYYY labels', () => {
  assert.equal(formatDateLabel('2026-08-24'), '24/08/2026');
  assert.equal(formatDateLabel('1999-12-01'), '01/12/1999');
});

test('formatDateLabel degrades gracefully on unexpected dia values', () => {
  for (const value of [null, undefined, '', 'junk', '2026-8-4', '2026-08-24T07:00:00']) {
    assert.equal(formatDateLabel(value), '', `value=${String(value)}`);
  }
});

test('plannedValue renders a dash placeholder for empty planned fields', () => {
  const training = { tipo: 'Corrida', treino: null, detalhes: '', rpe: 4 };
  assert.equal(plannedValue(training, 'tipo'), 'Corrida');
  assert.equal(plannedValue(training, 'rpe'), '4', 'numbers are stringified');
  assert.equal(plannedValue(training, 'treino'), '-');
  assert.equal(plannedValue(training, 'detalhes'), '-');
  assert.equal(plannedValue(training, 'fc_alvo'), '-');
  assert.equal(plannedValue(undefined, 'tipo'), '-');
});

test('normalizeFeedbackRpe keeps blank answers as null and valid integers as numbers', () => {
  assert.equal(normalizeFeedbackRpe(''), null);
  assert.equal(normalizeFeedbackRpe('   '), null);
  assert.equal(normalizeFeedbackRpe(null), null);
  assert.equal(normalizeFeedbackRpe(undefined), null);
  assert.equal(normalizeFeedbackRpe('3'), 3);
  assert.equal(normalizeFeedbackRpe(' 4 '), 4);
  assert.equal(normalizeFeedbackRpe(5), 5);
});

test('normalizeFeedbackRpe flags out-of-range or non-integer answers', () => {
  for (const raw of ['0', '6', '-1', '2.5', 'abc']) {
    assert.ok(Number.isNaN(normalizeFeedbackRpe(raw)), `raw=${raw}`);
  }
});

test('training-result.html is a lean session detail screen', () => {
  const html = readFileSync(join(publicDir, 'training-result.html'), 'utf8');

  assert.match(html, /<link rel="stylesheet" href="shared\/shell.css">/);
  assert.match(html, /<link rel="stylesheet" href="training-result.css">/);
  assert.match(html, /<script src="shared\/shell.js" type="module"><\/script>/);
  assert.match(html, /<script src="training-result.js" type="module"><\/script>/);

  assert.match(html, /data-i18n="session\.title"/);
  assert.match(html, /data-i18n="session\.plannedHeading"/);
  assert.match(html, /id="sessionDate"/);
  assert.match(html, /<p id="status" class="status" role="status"><\/p>/);

  for (const id of [
    'plannedTipo',
    'plannedTreino',
    'plannedDetalhes',
    'plannedFcAlvo',
    'plannedRpe',
    'plannedTenis',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} exists`);
  }

  assert.match(html, /data-i18n="session\.feedbackHeading"/);
  assert.match(
    html,
    /<input type="number" id="feedbackRpe" min="1" max="5" step="1" inputmode="numeric">/
  );
  assert.match(html, /<textarea id="feedbackNotas" rows="4"/);
  assert.match(html, /data-i18n-placeholder="session\.notesPlaceholder"/);
  assert.match(html, /<button id="saveBtn" class="btn-primary" type="button"/);
  assert.match(html, /data-i18n="session\.save"/);

  for (const legacy of ['dropzone', 'fileInput', 'generateBtn', 'markdownPreview', 'copyBtn', 'form-state.js']) {
    assert.ok(!html.includes(legacy), `${legacy} is gone from the refactored page`);
  }
});

test('training-result.js wires load, render, feedback save and i18n refreshes', () => {
  const js = readFileSync(join(publicDir, 'training-result.js'), 'utf8');

  assert.match(js, /import \{ initShell, getShellI18n \} from '\.\/shared\/shell\.js';/);
  assert.match(js, /import \{ fetchTraining, saveTrainingFeedback \} from '\.\/shared\/api\.js';/);

  assert.match(js, /resolveSessionId\(window\.location\.search\)/);
  assert.match(
    js,
    /if \(!id\) \{\s*\n\s*window\.location\.href = '\/calendar\.html';/,
    'missing id redirects back to the calendar'
  );

  assert.match(js, /await fetchTraining\(id\)/);
  assert.match(js, /t\('session\.errors\.load'\)/);
  assert.match(js, /t\('session\.errors\.notFound'\)/);

  assert.match(js, /for \(const \[field, elementId\] of PLANNED_FIELDS\) \{/);
  assert.match(js, /plannedValue\(training, field\)/);
  assert.match(js, /formatDateLabel\(training\.dia\)/);

  assert.match(js, /rpeInput\.value = training\.feedback_rpe \?\? '';/);
  assert.match(js, /notesInput\.value = training\.feedback_notas \?\? '';/);

  assert.match(js, /normalizeFeedbackRpe\(rpeInput\.value\)/);
  assert.match(js, /t\('session\.errors\.rpe'\)/);
  assert.match(
    js,
    /saveTrainingFeedback\(id, \{\s*\n\s*feedbackRpe,\s*\n\s*feedbackNotes: notesInput\.value,/
  );
  assert.match(js, /t\('session\.errors\.save'\)/);
  assert.match(
    js,
    /window\.location\.href = '\/calendar\.html';[\s\S]*?window\.location\.href = '\/calendar\.html';/,
    'both the missing-id and post-save flows land on the calendar'
  );

  assert.match(js, /document\.title = t\('training\.title'\);/);
  assert.match(js, /addEventListener\('app:languagechange'/);
});

test('shared api client exposes the session endpoints', () => {
  const js = readFileSync(join(publicDir, 'shared', 'api.js'), 'utf8');

  assert.match(js, /export async function fetchTraining\(id\) \{/);
  assert.match(js, /response = await fetch\(`\/api\/trainings\/\$\{id\}`/);
  assert.match(
    js,
    /if \(response\.status === 404\) return null;/,
    'a 404 becomes null so the page can show its not-found state'
  );
  assert.match(js, /export function saveTrainingFeedback\(id, \{ feedbackRpe, feedbackNotes \}\) \{/);
  assert.match(js, /\{ feedback_rpe: feedbackRpe, feedback_notas: feedbackNotes \},/);
  assert.match(js, /\s'PATCH'\s*\n\s*\);/);
});

test('session locale namespace stays in parity across en-US and pt-BR', () => {
  const SESSION_KEYS = [
    'title',
    'loading',
    'plannedHeading',
    'fieldTipo',
    'fieldTreino',
    'fieldDetalhes',
    'fieldFcAlvo',
    'fieldRpe',
    'fieldTenis',
    'feedbackHeading',
    'realizedRpeLabel',
    'notesLabel',
    'notesPlaceholder',
    'save',
    'saving',
    'errors.load',
    'errors.notFound',
    'errors.rpe',
    'errors.save',
  ];

  const lookup = (source, key) =>
    key.split('.').reduce((node, part) => (node ? node[part] : undefined), source);

  for (const key of SESSION_KEYS) {
    const english = lookup(en.session, key);
    const portuguese = lookup(pt.session, key);
    assert.equal(typeof english, 'string', `en.session.${key}`);
    assert.equal(typeof portuguese, 'string', `pt.session.${key}`);
  }

  assert.notEqual(en.session.save, pt.session.save);
  assert.equal(typeof en.training.title, 'string');
  assert.equal(typeof pt.training.title, 'string');

  assert.equal(en.shell.nav.training, undefined);
  assert.equal(pt.shell.nav.training, undefined);
});

test('training-result.css keeps the earthy premium aesthetic for the session view', () => {
  const css = readFileSync(join(publicDir, 'training-result.css'), 'utf8');

  assert.match(css, /@import url\('\.\/shared\/theme\.css'\);/);
  assert.match(css, /\.planned-grid \{[^}]*display:\s*grid/);
  assert.match(css, /\.planned-grid \{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.planned-item-wide \{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(css, /\.status\[data-tone='error'\] \{[^}]*color:\s*var\(--danger\)/);
  assert.match(css, /\.btn-primary \{[^}]*background:\s*var\(--accent-deep\)/);
  assert.match(css, /#feedbackNotas \{[^}]*resize:\s*vertical/);
  assert.match(css, /font-family: 'DM Sans', system-ui, -apple-system, sans-serif;/);
});
