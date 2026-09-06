'use strict';

const SUPPORTED_DISTANCE_UNITS = ['km', 'mi'];
const DEFAULT_DISTANCE_UNIT = 'km';
const SUPPORTED_TEMPERATURE_UNITS = ['C', 'F'];
const DEFAULT_TEMPERATURE_UNIT = 'C';

function normalizeUnit(value, supported, fallback) {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  return supported.find((unit) => unit.toLowerCase() === candidate.toLowerCase()) ?? fallback;
}

function normalizeDistanceUnit(value) {
  return normalizeUnit(value, SUPPORTED_DISTANCE_UNITS, DEFAULT_DISTANCE_UNIT);
}

function normalizeTemperatureUnit(value) {
  return normalizeUnit(value, SUPPORTED_TEMPERATURE_UNITS, DEFAULT_TEMPERATURE_UNIT);
}

function isSupportedUnit(value, supported) {
  return typeof value === 'string' && supported.some(
    (unit) => unit.toLowerCase() === value.trim().toLowerCase()
  );
}

function isSupportedDistanceUnit(value) {
  return isSupportedUnit(value, SUPPORTED_DISTANCE_UNITS);
}

function isSupportedTemperatureUnit(value) {
  return isSupportedUnit(value, SUPPORTED_TEMPERATURE_UNITS);
}

module.exports = {
  SUPPORTED_DISTANCE_UNITS,
  DEFAULT_DISTANCE_UNIT,
  SUPPORTED_TEMPERATURE_UNITS,
  DEFAULT_TEMPERATURE_UNIT,
  normalizeDistanceUnit,
  normalizeTemperatureUnit,
  isSupportedDistanceUnit,
  isSupportedTemperatureUnit,
};
