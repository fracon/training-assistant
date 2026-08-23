import { updateCalendarPreference } from './shared/api.js';
import { initShell, getShellI18n } from './shared/shell.js';
import { translate } from './shared/i18n.js';

export const WEEK_START_STORAGE_KEY = 'training-assistant:first-day-of-week';
export const SUPPORTED_WEEK_STARTS = ['Monday', 'Sunday'];
export const DEFAULT_WEEK_START = 'Monday';

export function normalizeClientWeekStart(...candidates) {
  for (const candidate of candidates) {
    if (SUPPORTED_WEEK_STARTS.includes(candidate)) return candidate;
  }
  return DEFAULT_WEEK_START;
}

export function readStoredWeekStart(storage = globalThis.localStorage) {
  try {
    return storage.getItem(WEEK_START_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveStoredWeekStart(value, storage = globalThis.localStorage) {
  try {
    storage.setItem(WEEK_START_STORAGE_KEY, value);
  } catch {
    /* storage unavailable - the in-memory preference still applies */
  }
}

export function syncStoredWeekStartFromUser(user, storage = globalThis.localStorage) {
  if (!user || !SUPPORTED_WEEK_STARTS.includes(user.first_day_of_week)) {
    return false;
  }
  saveStoredWeekStart(user.first_day_of_week, storage);
  return true;
}

export function weekdayOrder(firstDay) {
  if (firstDay === 'Sunday') {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  return [1, 2, 3, 4, 5, 6, 0];
}

// Locale name arrays are Monday-indexed (index 0 = Monday, 6 = Sunday),
// while Date.prototype.getDay() is Sunday-indexed (0 = Sunday).
export function weekdayArrayIndex(jsDay) {
  return (((jsDay % 7) + 7) % 7 + 6) % 7;
}

export function buildCalendarCells(year, monthIndex, firstDay, today = new Date()) {
  const order = weekdayOrder(firstDay);
  const firstOfMonth = new Date(year, monthIndex, 1);
  const leadingBlanks = order.indexOf(firstOfMonth.getDay());
  const start = new Date(year, monthIndex, 1 - leadingBlanks);

  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const isToday =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();
    cells.push({
      date,
      key: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
      dayNumber: date.getDate(),
      inMonth: date.getMonth() === monthIndex,
      isToday,
    });
  }
  return cells;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function setupCalendarPage() {
  const grid = document.getElementById('calendarGrid');
  const monthTitle = document.getElementById('monthTitle');
  const statusEl = document.getElementById('calendarStatus');
  const mondayBtn = document.getElementById('mondayBtn');
  const sundayBtn = document.getElementById('sundayBtn');
  const prevBtn = document.getElementById('prevMonthBtn');
  const nextBtn = document.getElementById('nextMonthBtn');

  const now = new Date();
  const state = {
    year: now.getFullYear(),
    monthIndex: now.getMonth(),
    firstDay: DEFAULT_WEEK_START,
  };

  let i18n = null;

  function t(key, params) {
    return translate(i18n ? i18n.messages : {}, key, params);
  }

  function syncToggleButtons() {
    mondayBtn.classList.toggle('active', state.firstDay === 'Monday');
    sundayBtn.classList.toggle('active', state.firstDay === 'Sunday');
  }

  function render() {
    monthTitle.textContent = `${t(`calendar.months.${state.monthIndex}`)} ${state.year}`;
    if (statusEl) {
      statusEl.textContent = monthTitle.textContent;
    }

    grid.innerHTML = '';
    const shortNames = [];
    for (let index = 0; index < 7; index += 1) {
      shortNames.push(t(`calendar.weekdaysShort.${index}`));
    }
    const headerLabels = weekdayOrder(state.firstDay).map(
      (jsDay) => shortNames[weekdayArrayIndex(jsDay)]
    );
    for (const label of headerLabels) {
      const head = el('div', 'weekday-head');
      head.textContent = label;
      grid.appendChild(head);
    }

    const longNames = [];
    for (let index = 0; index < 7; index += 1) {
      longNames.push(t(`calendar.weekdaysLong.${index}`));
    }
    for (const cell of buildCalendarCells(state.year, state.monthIndex, state.firstDay)) {
      const node = el(
        'div',
        `day-cell${cell.inMonth ? '' : ' outside'}${cell.isToday ? ' today' : ''}`
      );
      node.dataset.date = cell.key;
      const number = el('span', 'day-number');
      number.textContent = String(cell.dayNumber);
      node.appendChild(number);
      node.setAttribute(
        'aria-label',
        `${longNames[weekdayArrayIndex(cell.date.getDay())]} ${cell.dayNumber} ${t(`calendar.months.${cell.date.getMonth()}`)} ${cell.date.getFullYear()}`
      );
      grid.appendChild(node);
    }
  }

  async function applyWeekStart(next) {
    if (!SUPPORTED_WEEK_STARTS.includes(next) || next === state.firstDay) return;
    state.firstDay = next;
    saveStoredWeekStart(next);
    syncToggleButtons();
    render();
    try {
      await updateCalendarPreference(next);
    } catch {
      /* offline - keep rendering with the local preference */
    }
  }

  mondayBtn.addEventListener('click', () => applyWeekStart('Monday'));
  sundayBtn.addEventListener('click', () => applyWeekStart('Sunday'));

  prevBtn.addEventListener('click', () => {
    state.monthIndex -= 1;
    if (state.monthIndex < 0) {
      state.monthIndex = 11;
      state.year -= 1;
    }
    render();
  });

  nextBtn.addEventListener('click', () => {
    state.monthIndex += 1;
    if (state.monthIndex > 11) {
      state.monthIndex = 0;
      state.year += 1;
    }
    render();
  });

  document.addEventListener('app:languagechange', render);

  return {
    getState: () => ({ ...state }),
    start(user) {
      if (!user) return null;
      syncStoredWeekStartFromUser(user);
      state.firstDay = normalizeClientWeekStart(
        user.first_day_of_week,
        readStoredWeekStart()
      );
      i18n = getShellI18n();
      syncToggleButtons();
      render();
      return user;
    },
  };
}

export async function initCalendar() {
  const user = await initShell({ active: 'calendar' });
  if (!user) return null;

  const page = setupCalendarPage();
  page.start(user);
  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initCalendar().catch(() => window.location.replace('/login.html'));
}
