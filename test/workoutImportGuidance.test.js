'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

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

test('training result exposes the translated multibrand guide without native title or remote scripts', () => {
  const html = readFileSync(join(__dirname, '..', 'src', 'public', 'training-result.html'), 'utf8');
  assert.match(html, /id="importHelpBtn"[^>]*type="button"/);
  assert.match(html, /id="importHelpDialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /data-provider-id="garmin"/);
  assert.match(html, /data-provider-id="samsung"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\/(?!unpkg\.com\/lucide)/i);
  assert.doesNotMatch(html, /\stitle=/i);
});
