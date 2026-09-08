'use strict';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

function buildGeoUrl(name) {
  const params = new URLSearchParams({ name, count: '1', format: 'json' });
  return `${GEOCODING_URL}?${params}`;
}

function buildDailyUrl(endpoint, { latitude, longitude, date }) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    start_date: date,
    end_date: date,
    daily: 'temperature_2m_max,weather_code',
    timezone: 'auto',
  });
  return `${endpoint}?${params}`;
}

async function httpJson(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed (${response.status}).`);
  }
  return response.json();
}

async function geocodeLocation(name, fetchImpl = globalThis.fetch) {
  const payload = await httpJson(buildGeoUrl(name), fetchImpl);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const first = results.find(
    (result) => typeof result?.latitude === 'number' && typeof result?.longitude === 'number'
  );
  if (!first) return null;
  return {
    name: typeof first.name === 'string' && first.name.trim() !== '' ? first.name : name,
    latitude: first.latitude,
    longitude: first.longitude,
  };
}

function extractDaily(payload) {
  const temperature = payload?.daily?.temperature_2m_max?.[0];
  const code = payload?.daily?.weather_code?.[0];
  if (typeof temperature !== 'number' || typeof code !== 'number') return null;
  return { temperature_c: temperature, weather_code: code };
}

async function readEndpoint(endpoint, geo, date, fetchImpl) {
  const payload = await httpJson(
    buildDailyUrl(endpoint, { latitude: geo.latitude, longitude: geo.longitude, date }),
    fetchImpl
  );
  return extractDaily(payload);
}

// Resolves a planned location to its coordinates, then reads the max
// temperature and WMO weather code for the training date. The archive API
// covers past days; the forecast API is the fallback for recent/future dates.
async function resolveTrainingWeather(location, date, fetchImpl = globalThis.fetch) {
  let geo;
  try {
    geo = await geocodeLocation(location, fetchImpl);
  } catch {
    return { ok: false, status: 502, error: 'Weather service unavailable.' };
  }
  if (!geo) {
    return { ok: false, status: 404, error: 'Location not found.' };
  }

  let data = null;
  let source = null;
  try {
    data = await readEndpoint(ARCHIVE_URL, geo, date, fetchImpl);
    source = 'archive';
  } catch {
    data = null;
  }
  if (!data) {
    try {
      data = await readEndpoint(FORECAST_URL, geo, date, fetchImpl);
      source = 'forecast';
    } catch {
      data = null;
    }
  }
  if (!data) {
    return { ok: false, status: 502, error: 'Weather service unavailable.' };
  }
  return {
    ok: true,
    source,
    location: geo.name,
    latitude: geo.latitude,
    longitude: geo.longitude,
    date,
    temperature_c: data.temperature_c,
    weather_code: data.weather_code,
  };
}

module.exports = {
  GEOCODING_URL,
  ARCHIVE_URL,
  FORECAST_URL,
  buildGeoUrl,
  buildDailyUrl,
  httpJson,
  geocodeLocation,
  extractDaily,
  readEndpoint,
  resolveTrainingWeather,
};