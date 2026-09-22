'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

const publicDir = join(__dirname, '..', 'src', 'public');

function lookup(messages, key) {
  return key.split('.').reduce((value, part) => value?.[part], messages);
}

test('structured workout catalog has the eight required unique platforms and official sources', async () => {
  const { WORKOUT_CREATION_PLATFORMS } = await import('../src/public/shared/workout-creation-guidance.js');
  assert.deepEqual(WORKOUT_CREATION_PLATFORMS.map((platform) => platform.id), [
    'garmin', 'apple', 'coros', 'polar', 'suunto', 'samsung', 'xiaomi', 'huawei',
  ]);
  assert.equal(new Set(WORKOUT_CREATION_PLATFORMS.map((platform) => platform.id)).size, 8);
  for (const platform of WORKOUT_CREATION_PLATFORMS) {
    assert.match(platform.source, /^https:\/\//);
    assert.match(platform.verifiedAt, /^2026-09-22$/);
    assert.ok(['full', 'conditional', 'model-dependent'].includes(platform.compatibility));
    assert.equal(typeof platform.stepCount, 'number');
  }
});

test('creation guide exposes all platforms, safe links, and a separate dialog from import guidance', () => {
  const html = readFileSync(join(publicDir, 'training-result.html'), 'utf8');
  const trigger = html.indexOf('id="workoutCreationBtn"');
  const planned = html.indexOf('id="plannedTitle"');
  const dialog = html.indexOf('id="workoutCreationDialog"');
  const generalHeader = html.match(/<header class="session-header">[\s\S]*?<\/header>/)?.[0] ?? '';
  const plannedCard = html.match(/<section class="card planned-card"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.doesNotMatch(generalHeader, /workoutCreationBtn|deleteTrainingBtn|session-actions/);
  assert.ok(trigger >= planned && plannedCard.includes('id="workoutCreationBtn"') && plannedCard.includes('id="deleteTrainingBtn"'), 'creation action stays in the planned workout card');
  assert.ok(dialog > trigger);
  assert.match(html, /id="workoutCreationBtn"[^>]*data-i18n-aria-label="session\.workoutCreation\.openAriaLabel"/);
  assert.match(html, /id="workoutCreationDialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
  for (const id of ['garmin', 'apple', 'coros', 'polar', 'suunto', 'samsung', 'xiaomi', 'huawei']) {
    assert.match(html, new RegExp(`data-workout-create-platform="${id}"`));
  }
  assert.match(html, /data-workout-create-source[^>]*target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /id="importHelpDialog"/);
  assert.match(html, /<script src="training-result\.js" type="module"><\/script>/);
});

test('both locales contain translated guidance, limitations, and accessible labels', () => {
  for (const [messages, open, close, learn] of [
    [en, 'How do I create my workout?', 'Close workout creation guide', 'Learn more in the official documentation'],
    [pt, 'Como criar meu treino?', 'Fechar guia de criação de treino', 'Saiba mais na documentação oficial'],
  ]) {
    assert.equal(lookup(messages, 'session.workoutCreation.openShort'), open);
    assert.equal(typeof lookup(messages, 'session.workoutCreation.close'), 'string');
    assert.equal(lookup(messages, 'session.workoutCreation.close'), close);
    assert.equal(lookup(messages, 'session.workoutCreation.learnMore'), learn);
    assert.match(lookup(messages, 'session.workoutCreation.description'), /model|modelo/i);
    for (const id of ['garmin', 'apple', 'coros', 'polar', 'suunto', 'samsung', 'xiaomi', 'huawei']) {
      const base = `session.workoutCreation.platforms.${id}`;
      assert.ok(lookup(messages, `${base}.title`));
      assert.ok(lookup(messages, `${base}.note`));
      if (id === 'xiaomi') assert.match(lookup(messages, `${base}.fallback`), /official|oficial/i);
      else assert.ok(lookup(messages, `${base}.step1`));
    }
  }
});

test('creation guide keeps compatibility distinctions and has no session mutation hooks', () => {
  const js = readFileSync(join(publicDir, 'shared', 'workout-creation-guidance.js'), 'utf8');
  const css = readFileSync(join(publicDir, 'training-result.css'), 'utf8');
  assert.match(js, /model-dependent/);
  assert.match(js, /noopener|source/);
  assert.doesNotMatch(js, /fetch\(|saveTraining|fetchTraining|localStorage/);
  assert.match(css, /\.workout-creation-trigger:focus-visible/);
  assert.match(css, /\.workout-creation-dialog\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.workout-creation-platform-list/);
});
