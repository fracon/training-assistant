'use strict';

const UNSPLASH_URL = 'https://api.unsplash.com/photos/random?query=running,marathon,track,athletics&orientation=landscape';
const LOCAL_HERO_IMAGES = ['/assets/brand/kinesis_icon.png'];

function localHero(random = Math.random) {
  const roll = typeof random === 'function' ? random() : Math.random();
  const index = Math.min(LOCAL_HERO_IMAGES.length - 1, Math.max(0, Math.floor(roll * LOCAL_HERO_IMAGES.length)));
  return { url: LOCAL_HERO_IMAGES[index], source: 'local', author: null, authorUrl: null };
}

async function fetchHeroImage({ apiKey = process.env.UNSPLASH_API_KEY, fetchImpl = globalThis.fetch, random = Math.random } = {}) {
  if (!apiKey || typeof fetchImpl !== 'function') return localHero(random);
  try {
    const response = await fetchImpl(UNSPLASH_URL, {
      headers: { accept: 'application/json', authorization: `Client-ID ${apiKey}` },
    });
    if (!response.ok) throw new Error(`Unsplash responded with ${response.status}`);
    const payload = await response.json();
    const url = payload?.urls?.regular;
    if (typeof url !== 'string' || url.trim() === '') throw new Error('Unsplash response has no image URL');
    return {
      url,
      source: 'unsplash',
      author: payload.user?.name || null,
      authorUrl: payload.user?.links?.html || null,
    };
  } catch {
    return localHero(random);
  }
}

module.exports = { UNSPLASH_URL, LOCAL_HERO_IMAGES, fetchHeroImage, localHero };
