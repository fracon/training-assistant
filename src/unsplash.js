'use strict';

const UNSPLASH_URL = 'https://api.unsplash.com/photos/random?query=running,marathon,track&orientation=landscape';
const HERO_CACHE_TTL_MS = 20 * 60 * 1000;
const LOCAL_HERO_IMAGES = ['/assets/brand/kinesis_icon.png'];

function localHero(random = Math.random) {
  const roll = typeof random === 'function' ? random() : Math.random();
  const index = Math.min(LOCAL_HERO_IMAGES.length - 1, Math.max(0, Math.floor(roll * LOCAL_HERO_IMAGES.length)));
  return { url: LOCAL_HERO_IMAGES[index], source: 'local', author: null, authorUrl: null };
}

function createHeroImageLoader({ ttlMs = HERO_CACHE_TTL_MS, now = Date.now } = {}) {
  let cached = null;
  return async function loadHeroImage({ apiKey = process.env.UNSPLASH_API_KEY, fetchImpl = globalThis.fetch, random = Math.random } = {}) {
    if (!apiKey || typeof fetchImpl !== 'function') return localHero(random);
    if (cached && cached.apiKey === apiKey && cached.fetchImpl === fetchImpl && cached.expiresAt > now()) return cached.value;
    try {
      const response = await fetchImpl(UNSPLASH_URL, {
        headers: { accept: 'application/json', authorization: `Client-ID ${apiKey}` },
      });
      if (!response.ok) throw new Error(`Unsplash responded with ${response.status}`);
      const payload = await response.json();
      const url = payload?.urls?.regular;
      if (typeof url !== 'string' || url.trim() === '') throw new Error('Unsplash response has no image URL');
      const downloadLocation = payload?.links?.download_location;
      if (typeof downloadLocation === 'string' && downloadLocation.trim() !== '') {
        try {
          await fetchImpl(downloadLocation, { headers: { accept: 'application/json', authorization: `Client-ID ${apiKey}` } });
        } catch {
          // Download registration is best-effort; keep the valid image usable.
        }
      }
      const value = {
        url,
        source: 'unsplash',
        author: payload.user?.name || null,
        authorUrl: payload.user?.links?.html || null,
      };
      cached = { apiKey, fetchImpl, expiresAt: now() + ttlMs, value };
      return value;
    } catch {
      return localHero(random);
    }
  };
}

const fetchHeroImage = createHeroImageLoader();

module.exports = { UNSPLASH_URL, HERO_CACHE_TTL_MS, LOCAL_HERO_IMAGES, createHeroImageLoader, fetchHeroImage, localHero };
