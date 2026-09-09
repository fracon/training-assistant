'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchHeroImage, LOCAL_HERO_IMAGES, UNSPLASH_URL, localHero } = require('../src/unsplash');

test('fetchHeroImage returns the Unsplash image and attribution on success', async () => {
  const calls = [];
  const result = await fetchHeroImage({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { urls: { regular: 'https://images.unsplash.com/running.jpg' }, user: { name: 'Runner', links: { html: 'https://unsplash.com/@runner' } } };
        },
      };
    },
  });
  assert.equal(result.url, 'https://images.unsplash.com/running.jpg');
  assert.equal(result.source, 'unsplash');
  assert.equal(result.author, 'Runner');
  assert.equal(calls[0].url, UNSPLASH_URL);
  assert.equal(calls[0].options.headers.authorization, 'Client-ID test-key');
});

test('fetchHeroImage tolerates optional response metadata and disabled fetch clients', async () => {
  const withoutFetch = await fetchHeroImage({ apiKey: 'test-key', fetchImpl: null, random: () => -1 });
  assert.equal(withoutFetch.source, 'local');
  assert.equal(localHero(0).url, LOCAL_HERO_IMAGES[0]);
  const noAuthor = await fetchHeroImage({
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: true, async json() { return { urls: { regular: 'https://images.unsplash.com/photo.jpg' } }; } }),
    random: () => 2,
  });
  assert.equal(noAuthor.author, null);
  assert.equal(noAuthor.authorUrl, null);
  const missingUrl = await fetchHeroImage({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, async json() { return {}; } }) });
  assert.equal(missingUrl.source, 'local');
});

test('fetchHeroImage falls back locally when key is missing or Unsplash fails', async () => {
  const missing = await fetchHeroImage({ apiKey: '' });
  assert.equal(missing.source, 'local');
  assert.ok(LOCAL_HERO_IMAGES.includes(missing.url));
  const failed = await fetchHeroImage({ apiKey: 'test-key', fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(failed.source, 'local');
  const broken = await fetchHeroImage({ apiKey: 'test-key', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(broken.source, 'local');
});
