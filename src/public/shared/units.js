export const KM_TO_MILES = 0.621371;
export const MILES_TO_KM = 1 / KM_TO_MILES;

export function normalizeDistanceUnit(unit) {
  return unit === 'mi' ? 'mi' : 'km';
}

export function normalizeTemperatureUnit(unit) {
  return unit === 'F' ? 'F' : 'C';
}

export function convertDistanceFromKm(value, unit = 'km') {
  const kilometers = Number(value);
  if (!Number.isFinite(kilometers)) return 0;
  return normalizeDistanceUnit(unit) === 'mi' ? kilometers * KM_TO_MILES : kilometers;
}

export function convertCelsius(value, unit = 'C') {
  const celsius = Number(value);
  if (!Number.isFinite(celsius)) return 0;
  return normalizeTemperatureUnit(unit) === 'F' ? (celsius * 9) / 5 + 32 : celsius;
}

export function formatDistance(valueKm, unit = 'km', decimals = 2) {
  const normalized = normalizeDistanceUnit(unit);
  const value = convertDistanceFromKm(valueKm, normalized);
  return `${value.toFixed(decimals)} ${normalized}`;
}

export function formatTemperature(valueCelsius, unit = 'C', decimals = 0) {
  const normalized = normalizeTemperatureUnit(unit);
  const value = convertCelsius(valueCelsius, normalized);
  return `${value.toFixed(decimals)} °${normalized}`;
}

export function distancePromptUnit(unit = 'km') {
  return normalizeDistanceUnit(unit) === 'mi' ? 'miles' : 'km';
}

export function temperaturePromptUnit(unit = 'C') {
  return normalizeTemperatureUnit(unit) === 'F' ? '°F' : '°C';
}

export function formatPaceFromMetric(value, unit = 'km') {
  if (value === null || value === undefined || String(value).trim() === '') return '-';
  if (normalizeDistanceUnit(unit) !== 'mi') return `${value} min/km`;
  const match = /^(\d+):([0-5]\d)$/.exec(String(value).trim());
  if (!match) return `${value} min/mi`;
  const seconds = (Number(match[1]) * 60 + Number(match[2])) / KM_TO_MILES;
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')} min/mi`;
}
