export const PREFERENCES_STORAGE_KEY = 'kinesis:user-preferences';

export const DEFAULT_USER_PREFERENCES = Object.freeze({
  first_day_of_week: 'Monday',
  distance_unit: 'km',
  temperature_unit: 'C',
});

const SUPPORTED = {
  first_day_of_week: ['Monday', 'Sunday'],
  distance_unit: ['km', 'mi'],
  temperature_unit: ['C', 'F'],
};

export function normalizeUserPreferences(values = {}) {
  const result = {};
  for (const key of Object.keys(DEFAULT_USER_PREFERENCES)) {
    const value = values?.[key];
    result[key] = SUPPORTED[key].includes(value) ? value : DEFAULT_USER_PREFERENCES[key];
  }
  return result;
}

export function readUserPreferences(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(PREFERENCES_STORAGE_KEY);
    return normalizeUserPreferences(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULT_USER_PREFERENCES };
  }
}

export function writeUserPreferences(values, storage = globalThis.localStorage) {
  const normalized = normalizeUserPreferences(values);
  try {
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* storage unavailable - server persistence still applies */
  }
  return normalized;
}
