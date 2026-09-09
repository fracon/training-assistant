'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

function lookup(messages, key) {
  return key.split('.').reduce((value, part) => value?.[part], messages);
}

test('multibrand import catalog has seven auditable providers and safe statuses', async () => {
  const { WORKOUT_IMPORT_PROVIDERS, providerById, normalizeProvider, providerFormatKeys, providerStatusKey } =
    await import('../src/public/shared/workout-import-guidance.js');
  assert.deepEqual(WORKOUT_IMPORT_PROVIDERS.map((provider) => provider.id), ['garmin', 'coros', 'polar', 'amazfit-zepp', 'huawei', 'apple', 'samsung']);
  assert.equal(new Set(WORKOUT_IMPORT_PROVIDERS.map((provider) => provider.id)).size, 7);
  for (const provider of WORKOUT_IMPORT_PROVIDERS) {
    assert.match(provider.source, /^https:\/\//);
    assert.match(provider.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(providerStatusKey(provider), /^session\.importHelp\.status\./);
    assert.ok(Array.isArray(providerFormatKeys(provider)));
  }
  assert.equal(providerById('missing').id, 'garmin');
  assert.equal(normalizeProvider({ compatibility: 'invalid' }).id, 'garmin');
  assert.equal(providerById('garmin').compatibility, 'direct');
  assert.equal(providerById('amazfit-zepp').compatibility, 'unverified');
});

test('COROS guidance matches the official app export flow in both locales', async () => {
  const { providerById, providerFormatKeys } = await import('../src/public/shared/workout-import-guidance.js');
  const coros = providerById('coros');
  assert.equal(coros.compatibility, 'direct');
  assert.deepEqual(coros.formats, ['fit']);
  assert.match(coros.source, /^https:\/\/support\.coros\.com\/hc\/en-us\/articles\/360043975752-/);
  assert.equal(coros.stepCount, 6);
  assert.deepEqual(providerFormatKeys(coros), ['session.importHelp.formats.fit']);
  for (const messages of [en, pt]) {
    const steps = Array.from({ length: coros.stepCount }, (_, index) => lookup(messages, `session.importHelp.providers.coros.step${index + 1}`));
    assert.equal(steps.length, 6);
    assert.ok(steps.every((step) => typeof step === 'string' && step.length > 0));
    assert.match(steps.join(' '), /COROS|COROS/i);
    assert.match(steps.join(' '), /Export Data/);
    assert.match(steps.join(' '), /FIT/);
    assert.match(steps.at(-1), /Kinesis/);
    assert.doesNotMatch(steps.join(' '), /Training Hub/i);
  }
});

test('training result exposes the translated multibrand guide without native title or remote scripts', () => {
  const html = readFileSync(join(__dirname, '..', 'src', 'public', 'training-result.html'), 'utf8');
  assert.match(html, /id="importHelpBtn"[^>]*type="button"/);
  assert.match(html, /id="importHelpDialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /data-provider-id="garmin"/);
  assert.match(html, /data-provider-id="samsung"/);
  assert.match(html, /role="group"/);
  assert.doesNotMatch(html, /role="tablist"|role="tab"|aria-selected/);
  const providerButtons = [...html.matchAll(/<button type="button" data-provider-id="([^"]+)" aria-pressed="(true|false)">/g)];
  assert.equal(providerButtons.length, 7);
  assert.equal(providerButtons.filter(([, , pressed]) => pressed === 'true').length, 1);
  assert.equal(providerButtons[0][2], 'true');
  assert.ok(providerButtons.slice(1).every(([, , pressed]) => pressed === 'false'));
  assert.doesNotMatch(html, /data-provider-id="[^"]+"[^>]*tabindex="-1"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\/(?!unpkg\.com\/lucide)/i);
  assert.doesNotMatch(html, /\stitle=/i);
});
