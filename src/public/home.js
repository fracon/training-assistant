import { fetchActiveCycle, fetchCalendarTrainings } from './shared/api.js';
import { initShell, getShellI18n } from './shared/shell.js';
import { translate } from './shared/i18n.js';

export const ZENQUOTES_URL = 'https://zenquotes.io/api/today';
export const QUOTE_TIMEOUT_MS = 3000;
export const DAY_MS = 86400000;
export const DEFAULT_DISPLAY_LANGUAGE = 'en-US';

// Deterministic hero rotation: collisions on day-of-week remain harmless
// because the rotation is stable across the whole day, never per page load.
export const HERO_IMAGES = [
  'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1486218119243-13883505764c?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1506748686214-e9df14d4d9d0?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1454496522488-7a8e488e8606?auto=format&fit=crop&w=1600&q=80',
];

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function heroImageIndex(date = new Date()) {
  return date.getDay() % HERO_IMAGES.length;
}

export function heroImageFor(date = new Date()) {
  return HERO_IMAGES[heroImageIndex(date)] ?? HERO_IMAGES[0];
}

// The dashboard week always runs Monday → Sunday regardless of the
// per-user calendar week-start preference.
export function mondayOfWeek(date) {
  const normalized = startOfDay(date);
  const daysSinceMonday = (normalized.getDay() + 6) % 7;
  normalized.setDate(normalized.getDate() - daysSinceMonday);
  return normalized;
}

export function weekRange(today = new Date()) {
  const start = mondayOfWeek(today);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { start: isoDate(start), end: isoDate(end) };
}

export function trainingsInRange(trainings, start, end) {
  return (Array.isArray(trainings) ? trainings : []).filter(
    (entry) =>
      entry &&
      typeof entry.dia === 'string' &&
      entry.dia >= start &&
      entry.dia <= end
  );
}

// FIT durations are stored as "H:MM:SS" or "MM:SS"; malformed values are
// treated as zero so a missing upload never taints the weekly total.
export function parseDurationToSeconds(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 0;
  const parts = raw.split(':').map(Number);
  if (parts.length === 0 || parts.some((value) => !Number.isFinite(value))) return 0;
  let total = 0;
  for (const part of parts) total = total * 60 + part;
  return total;
}

export function accumulateWeeklyMetrics(trainings) {
  const list = Array.isArray(trainings) ? trainings : [];
  let distanceKm = 0;
  let durationSeconds = 0;
  for (const entry of list) {
    const distance = Number(entry?.fit_distance);
    if (Number.isFinite(distance) && distance > 0) distanceKm += distance;
    durationSeconds += parseDurationToSeconds(entry?.fit_duration);
  }
  return { distanceKm, durationSeconds };
}

export function formatDistanceKm(km) {
  return `${Number(km || 0).toFixed(2)} km`;
}

export function formatDuration(seconds) {
  const totalMinutes = Math.round((seconds || 0) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function parseIsoDate(iso) {
  if (typeof iso !== 'string') return null;
  const parts = iso.split('-').map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return null;
  const [year, month, day] = parts;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day);
}

// Monday → Sunday labels resolve through the locale dictionaries and stay
// index-stable so the tracker can map each ISO day to its abbreviation.
export const WEEKDAY_KEYS = [
  'home.days.mon',
  'home.days.tue',
  'home.days.wed',
  'home.days.thu',
  'home.days.fri',
  'home.days.sat',
  'home.days.sun',
];

export function weekDays(range) {
  const start = parseIsoDate(range?.start);
  if (!start) return [];
  const days = [];
  for (let i = 0; i < WEEKDAY_KEYS.length; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    days.push({ date: isoDate(date), key: WEEKDAY_KEYS[i] });
  }
  return days;
}

export function trainingDaySet(trainings) {
  const set = new Set();
  const list = Array.isArray(trainings) ? trainings : [];
  for (const entry of list) {
    if (entry && typeof entry.dia === 'string' && entry.dia.trim() !== '') {
      set.add(entry.dia);
    }
  }
  return set;
}

export function weekDayState(days, trainingSet) {
  const pool = trainingSet instanceof Set ? trainingSet : new Set();
  return days.map((day) => ({ ...day, hasTraining: pool.has(day.date) }));
}

export function buildWeekDayMarkup(state, messages) {
  return {
    cls: state.hasTraining ? 'week-day has-training' : 'week-day empty',
    label: translate(messages, state.key),
    dataI18n: state.key,
    ariaLabel: state.date,
  };
}

// Renders the 7 shimmer cells. Each cell carries its i18n key so the global
// scanner re-translates it on language switch; the caller also re-renders
// explicitly via the app:languagechange handler.
export function renderWeekDays(container, states, messages) {
  if (!container || !Array.isArray(states)) return;
  container.textContent = '';
  for (const state of states) {
    const markup = buildWeekDayMarkup(state, messages);
    const cell = document.createElement('div');
    cell.className = markup.cls;
    cell.setAttribute('data-i18n', markup.dataI18n);
    cell.setAttribute('aria-label', markup.ariaLabel);
    cell.textContent = markup.label;
    container.appendChild(cell);
  }
}

export function weeksBetween(startIso, endIso) {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!start || !end) return null;
  const days = Math.round((end - start) / DAY_MS);
  return Math.max(1, Math.ceil(days / 7));
}

export function currentWeekNumber(startIso, today = new Date()) {
  const start = parseIsoDate(startIso);
  if (!start) return null;
  const days = Math.round((startOfDay(today) - start) / DAY_MS);
  if (days < 0) return 1;
  return Math.floor(days / 7) + 1;
}

export function cycleProgress(cycle, today = new Date()) {
  if (!cycle || typeof cycle.start_date !== 'string') return null;
  const total = weeksBetween(cycle.start_date, cycle.target_date);
  const current = currentWeekNumber(cycle.start_date, today);
  if (current === null) return null;
  if (total === null) {
    return { current: Math.max(1, current), total: null, percent: null };
  }
  const clamped = Math.min(Math.max(1, current), total);
  return { current: clamped, total, percent: Math.round((clamped / total) * 100) };
}

export function daysRemainingUntil(targetIso, today = new Date()) {
  const target = parseIsoDate(targetIso);
  if (!target) return null;
  return Math.round((target - startOfDay(today)) / DAY_MS);
}

// pt-BR renders dd/mm/yyyy; other locales keep the ISO sortable key so the
// value survives string comparisons and spreadsheet exports unchanged.
export function formatTargetDate(iso, language) {
  const date = parseIsoDate(iso);
  if (!date) return '';
  const isPortuguese = typeof language === 'string' && language.toLowerCase().startsWith('pt');
  if (!isPortuguese) return iso;
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

export function cycleWeekText(messages, progress) {
  if (!progress || progress.current == null) return '';
  if (progress.total == null) {
    return translate(messages, 'home.cycle.weekOnly', { current: progress.current });
  }
  return translate(messages, 'home.cycle.weekLabel', {
    current: progress.current,
    total: progress.total,
  });
}

export function daysRemainingText(messages, days) {
  if (typeof days !== 'number') return '';
  if (days < 0) return translate(messages, 'home.cycle.daysRemaining.over');
  if (days === 0) return translate(messages, 'home.cycle.daysRemaining.today');
  if (days === 1) return translate(messages, 'home.cycle.daysRemaining.one');
  return translate(messages, 'home.cycle.daysRemaining.many', { count: days });
}

export function cycleCardContent(cycle, messages, today = new Date(), language = DEFAULT_DISPLAY_LANGUAGE) {
  if (!cycle) return null;
  const progress = cycleProgress(cycle, today);
  const daysRemaining = daysRemainingUntil(cycle.target_date, today);
  return {
    name: cycle.objective || cycle.distance || '',
    objective: cycle.objective || '',
    targetDate: cycle.target_date || '',
    targetDisplay: formatTargetDate(cycle.target_date, language),
    daysRemaining,
    daysRemainingText: daysRemaining == null ? '' : daysRemainingText(messages, daysRemaining),
    weekText: cycleWeekText(messages, progress),
    percent: progress ? progress.percent : null,
    hasProgress: Boolean(progress && progress.total != null),
  };
}

export function metricsCardContent(metrics) {
  const { distanceKm = 0, durationSeconds = 0 } = metrics || {};
  return { distance: formatDistanceKm(distanceKm), time: formatDuration(durationSeconds) };
}

// Renders one and only one cycle state. Every switch touches BOTH sibling
// containers, backed by the .hidden class, an aria-hidden mirror, and an
// inline display fallback so a stylesheet regression can never make the
// empty state and the active card render together.
export function applyCycleVisibility(containers, hasCycle) {
  const emptyContainer = containers?.emptyContainer;
  const activeContainer = containers?.activeContainer;
  if (!emptyContainer || !activeContainer) return;
  emptyContainer.classList.toggle('hidden', hasCycle);
  activeContainer.classList.toggle('hidden', !hasCycle);
  emptyContainer.setAttribute('aria-hidden', String(hasCycle));
  activeContainer.setAttribute('aria-hidden', String(!hasCycle));
  emptyContainer.style.display = hasCycle ? 'none' : '';
  activeContainer.style.display = hasCycle ? '' : 'none';
}

export function randomFallbackQuote(messages, random = Math.random) {
  const quotes = messages?.home?.hero?.fallbackQuotes;
  if (!Array.isArray(quotes) || quotes.length === 0) return null;
  const roll = random();
  const index = Math.min(quotes.length - 1, Math.max(0, Math.floor(roll * quotes.length)));
  return quotes[index] ?? null;
}

export function normalizeZenQuote(data) {
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry || typeof entry !== 'object') return null;
  const text = entry.q;
  if (typeof text !== 'string' || text.trim() === '') return null;
  return { text: text.trim(), author: typeof entry.a === 'string' ? entry.a.trim() : '' };
}

// Fetches the daily quote with a hard timeout and a CORS/network-proof
// fallback. Never throws: the caller always receives a quote object or null.
export async function loadQuote({
  fetchImpl = globalThis.fetch,
  messages = {},
  random = Math.random,
  timeoutMs = QUOTE_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ZENQUOTES_URL, { signal: controller.signal });
    if (!response.ok) throw new Error('ZenQuotes request failed');
    const data = await response.json();
    const quote = normalizeZenQuote(data);
    if (quote) return { ...quote, source: 'api' };
    throw new Error('ZenQuotes returned no quote');
  } catch {
    const fallback = randomFallbackQuote(messages, random);
    if (!fallback) return null;
    return { text: fallback.text, author: fallback.author, source: 'fallback' };
  } finally {
    clearTimeout(timer);
  }
}

export function applyHeroImage(banner, imageUrl) {
  if (!banner || typeof imageUrl !== 'string') return;
  banner.style.setProperty('--hero-image', `url("${imageUrl}")`);
}

function setupHomePage() {
  const heroBanner = document.getElementById('heroBanner');
  const quoteLoading = document.getElementById('heroQuoteLoading');
  const quoteBlock = document.getElementById('heroQuote');
  const quoteText = document.getElementById('heroQuoteText');
  const quoteAuthor = document.getElementById('heroQuoteAuthor');
  const cycleEmpty = document.getElementById('cycleEmpty');
  const cycleActive = document.getElementById('cycleActive');
  const cycleName = document.getElementById('cycleName');
  const cycleObjective = document.getElementById('cycleObjective');
  const cycleDaysLeft = document.getElementById('cycleDaysLeft');
  const cycleTarget = document.getElementById('cycleTarget');
  const cycleWeek = document.getElementById('cycleWeek');
  const cycleProgressRow = document.getElementById('cycleProgressRow');
  const cycleProgressBar = document.getElementById('cycleProgressBar');
  const cyclePercent = document.getElementById('cyclePercent');
  const weeklyDistance = document.getElementById('weeklyDistanceValue');
  const weeklyTime = document.getElementById('weeklyTimeValue');
  const weekTrackerDays = document.getElementById('weekTrackerDays');

  const state = {
    cycle: null,
    distanceKm: 0,
    durationSeconds: 0,
    quoteSource: 'api',
    range: null,
    trainingDates: new Set(),
  };

  let i18n = null;

  function t(key, params) {
    return translate(i18n ? i18n.messages : {}, key, params);
  }

  function renderQuote(quote) {
    if (!quote) return;
    if (quoteLoading) quoteLoading.classList.add('hidden');
    if (quoteBlock) quoteBlock.classList.remove('hidden');
    if (quoteText) quoteText.textContent = quote.text;
    if (quoteAuthor) quoteAuthor.textContent = quote.author;
  }

  function renderCycle() {
    if (!cycleEmpty || !cycleActive) return;
    const hasCycle = Boolean(state.cycle);
    applyCycleVisibility({ emptyContainer: cycleEmpty, activeContainer: cycleActive }, hasCycle);
    if (!hasCycle) return;
    const messages = i18n ? i18n.messages : {};
    const language = i18n ? i18n.language : DEFAULT_DISPLAY_LANGUAGE;
    const content = cycleCardContent(state.cycle, messages, new Date(), language);
    if (cycleName) cycleName.textContent = content.name;
    if (cycleObjective) {
      if (content.objective && content.objective !== content.name) {
        cycleObjective.textContent = content.objective;
        cycleObjective.classList.remove('hidden');
      } else {
        cycleObjective.textContent = '';
        cycleObjective.classList.add('hidden');
      }
    }
    if (cycleDaysLeft) cycleDaysLeft.textContent = content.daysRemainingText;
    if (cycleTarget) cycleTarget.textContent = content.targetDisplay;
    if (cycleWeek) cycleWeek.textContent = content.weekText;
    if (cycleProgressRow) cycleProgressRow.classList.toggle('hidden', !content.hasProgress);
    if (cycleProgressBar && content.percent != null) cycleProgressBar.value = content.percent;
    if (cyclePercent) {
      cyclePercent.textContent =
        content.percent == null ? '' : t('home.cycle.percentLabel', { percent: content.percent });
    }
  }

  function renderMetrics() {
    const content = metricsCardContent({
      distanceKm: state.distanceKm,
      durationSeconds: state.durationSeconds,
    });
    if (weeklyDistance) weeklyDistance.textContent = content.distance;
    if (weeklyTime) weeklyTime.textContent = content.time;
  }

  function renderWeekTracker() {
    if (!weekTrackerDays || !state.range) return;
    const states = weekDayState(weekDays(state.range), state.trainingDates);
    renderWeekDays(weekTrackerDays, states, i18n ? i18n.messages : {});
  }

  function render() {
    renderCycle();
    renderMetrics();
    renderWeekTracker();
  }

  async function loadCycle() {
    state.cycle = await fetchActiveCycle();
    renderCycle();
  }

  async function loadMetrics() {
    const range = weekRange();
    const trainings = await fetchCalendarTrainings(range.start, range.end);
    const weekTrainings = trainingsInRange(trainings, range.start, range.end);
    const metrics = accumulateWeeklyMetrics(weekTrainings);
    state.distanceKm = metrics.distanceKm;
    state.durationSeconds = metrics.durationSeconds;
    state.range = range;
    state.trainingDates = trainingDaySet(weekTrainings);
    renderMetrics();
    renderWeekTracker();
  }

  async function loadHeroQuote() {
    const quote = await loadQuote({ messages: i18n ? i18n.messages : {} });
    state.quoteSource = quote ? quote.source : 'fallback';
    renderQuote(quote);
  }

  // Dynamic content (fallback quotes, cycle card, metric values, day labels)
  // re-renders in the active dictionary. A live ZenQuotes quote is left
  // untouched so a language toggle never flashes a replacement over the API
  // text.
  document.addEventListener('app:languagechange', () => {
    render();
    if (state.quoteSource === 'fallback' && i18n) {
      renderQuote(randomFallbackQuote(i18n.messages));
    }
  });

  return {
    getState: () => ({ ...state }),
    start(user) {
      if (!user) return null;
      i18n = getShellI18n();
      applyHeroImage(heroBanner, heroImageFor());
      loadHeroQuote();
      loadCycle();
      loadMetrics();
      return user;
    },
  };
}

export async function initHomePage() {
  const user = await initShell({ active: 'dashboard' });
  if (!user) return null;

  const page = setupHomePage();
  page.start(user);
  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initHomePage().catch(() => window.location.replace('/login.html'));
}