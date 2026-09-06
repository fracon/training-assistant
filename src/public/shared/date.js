const PT_LOCALE = 'pt-BR';
const EN_LOCALE = 'en-US';

export function dateLocale(language) {
  return typeof language === 'string' && language.toLowerCase().startsWith('pt')
    ? PT_LOCALE
    : EN_LOCALE;
}

function dateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]) ? date : null;
}

export function formatDate(value, language = EN_LOCALE) {
  const date = dateOnly(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(dateLocale(language), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function parseLocalizedDate(value, language = EN_LOCALE) {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return '';
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  const pt = dateLocale(language) === PT_LOCALE;
  const month = pt ? second : first;
  const day = pt ? first : second;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return '';
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatDateInput(value, language = EN_LOCALE) {
  return formatDate(value, language);
}

export function formatWeekday(value, language = EN_LOCALE) {
  const date = dateOnly(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(dateLocale(language), {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(date);
}
