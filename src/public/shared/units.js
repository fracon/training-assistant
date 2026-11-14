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

// Form controls display the preferred unit while SQLite remains metric. This
// inverse keeps conversion centralized rather than leaking it into pages.
export function convertDistanceToKm(value, unit = 'km') {
  const distance = Number(value);
  if (!Number.isFinite(distance)) return 0;
  return normalizeDistanceUnit(unit) === 'mi' ? distance * MILES_TO_KM : distance;
}

// Input values need different invalid-value semantics from display helpers:
// preserve an unfinished or invalid edit instead of coercing it to zero.
export function convertDistanceInputValue(value, fromUnit = 'km', toUnit = 'km', decimals = 3) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const distance = Number(text);
  if (!Number.isFinite(distance)) return null;
  const kilometers = convertDistanceToKm(distance, fromUnit);
  const converted = convertDistanceFromKm(kilometers, toUnit);
  return Number(converted.toFixed(decimals));
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

// Body measurements (issue #80). Storage is always kilograms and centimetres;
// the account's `body_unit` preference only chooses kg/cm or lb/feet-inches.
export const KG_TO_LB = 2.20462262;
export const CM_PER_INCH = 2.54;

export function normalizeBodyUnit(unit) {
  return unit === 'imperial' ? 'imperial' : 'metric';
}

export function weightFromKg(valueKg, unit = 'metric') {
  if (valueKg === null || valueKg === undefined || valueKg === '') return null;
  const kilograms = Number(valueKg);
  if (!Number.isFinite(kilograms)) return null;
  return normalizeBodyUnit(unit) === 'imperial' ? kilograms * KG_TO_LB : kilograms;
}

export function weightToKg(value, unit = 'metric') {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const weight = Number(text);
  if (!Number.isFinite(weight)) return null;
  return normalizeBodyUnit(unit) === 'imperial' ? weight / KG_TO_LB : weight;
}

export function weightUnitLabel(unit = 'metric') {
  return normalizeBodyUnit(unit) === 'imperial' ? 'lb' : 'kg';
}

export function formatWeight(valueKg, unit = 'metric', decimals = 1) {
  const value = weightFromKg(valueKg, unit);
  if (value === null) return '';
  return `${value.toFixed(decimals)} ${weightUnitLabel(unit)}`;
}

// Imperial heights are typed as whole feet plus inches (one decimal).
export function heightFromCm(valueCm, unit = 'metric') {
  if (valueCm === null || valueCm === undefined || valueCm === '') return null;
  const centimetres = Number(valueCm);
  if (!Number.isFinite(centimetres)) return null;
  if (normalizeBodyUnit(unit) !== 'imperial') return { cm: Math.round(centimetres * 10) / 10 };
  const totalInches = Math.round((centimetres / CM_PER_INCH) * 10) / 10;
  const feet = Math.floor(totalInches / 12);
  return { feet, inches: Math.round((totalInches - feet * 12) * 10) / 10 };
}

export function heightToCm(value, unit = 'metric') {
  const read = (part) => {
    const text = String(part ?? '').trim();
    if (text === '') return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : NaN;
  };
  if (normalizeBodyUnit(unit) !== 'imperial') {
    const cm = read(value?.cm);
    return cm === null || Number.isNaN(cm) ? null : cm;
  }
  const feet = read(value?.feet);
  const inches = read(value?.inches) ?? 0;
  if (feet === null || Number.isNaN(feet) || Number.isNaN(inches)) return null;
  return (feet * 12 + inches) * CM_PER_INCH;
}

export function formatHeight(valueCm, unit = 'metric') {
  const height = heightFromCm(valueCm, unit);
  if (!height) return '';
  return 'cm' in height ? `${height.cm} cm` : `${height.feet} ft ${height.inches} in`;
}
