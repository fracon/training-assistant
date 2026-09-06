import { updateCalendarPreference, fetchCalendarTrainings, importTrainingsFile, fetchActiveCycle } from './shared/api.js';
import { initShell, getShellI18n, refreshIcons, showShellToast } from './shared/shell.js';
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

// DB dates are zero-padded ISO strings; grid cell keys use bare numbers.
export function keyFromIso(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return `${year}-${month}-${day}`;
}

export function trainingsByDay(trainings) {
  const byDay = new Map();
  for (const training of trainings) {
    const key = keyFromIso(training.dia);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(training);
  }
  return byDay;
}

// Resolves the list of row issues worth showing in the import modal.
// Returns null whenever there is nothing meaningful to display so the
// modal can never open empty (e.g. network blips on initial load).
export function importErrorEntries(error) {
  if (!error) return null;
  if (Array.isArray(error.rowErrors) && error.rowErrors.length > 0) {
    return error.rowErrors;
  }
  if (error.message) {
    return [{ row: '—', col: '—', error: error.message }];
  }
  return null;
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

// Pure view-model for a calendar training chip: the Tipo renders as the
// small secondary line, the full untruncated Treino as the main line.
export function chipLines(training) {
  return {
    type: training.tipo,
    title: training.treino && training.treino !== '' ? training.treino : '',
  };
}

// Sessions are contextual: clicking a chip deep-links into the result page.
export function trainingResultUrl(id) {
  return `/training-result.html?id=${id}`;
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
    trainings: [],
  };

  let i18n = null;

  function t(key, params) {
    return translate(i18n ? i18n.messages : {}, key, params);
  }

  function appendTrainingChips(cellNode, dayTrainings) {
    const visible = dayTrainings.slice(0, 3);
    for (const training of visible) {
      const lines = chipLines(training);
      const chip = el('span', 'training-chip');
      const type = el('span', 'chip-type');
      type.textContent = lines.type;
      chip.appendChild(type);
      if (lines.title) {
        const title = el('span', 'chip-title');
        title.textContent = lines.title;
        chip.appendChild(title);
      }
      if (training.detalhes) {
        const tooltip = el('div', 'chip-tooltip');
        tooltip.textContent = training.detalhes;
        chip.appendChild(tooltip);
      }
      chip.dataset.trainingId = String(training.id);
      chip.addEventListener('click', () => {
        window.location.href = trainingResultUrl(training.id);
      });
      cellNode.appendChild(chip);
    }
    if (dayTrainings.length > visible.length) {
      const more = el('span', 'training-chip chip-more');
      more.textContent = `+${dayTrainings.length - visible.length}`;
      more.title = t('calendar.import.title');
      cellNode.appendChild(more);
    }
  }

  function syncToggleButtons() {
    mondayBtn.textContent = t('calendar.mon');
    sundayBtn.textContent = t('calendar.sun');
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
    const byDay = trainingsByDay(state.trainings);
    for (const cell of buildCalendarCells(state.year, state.monthIndex, state.firstDay)) {
      const node = el(
        'div',
        `day-cell${cell.inMonth ? '' : ' outside'}${cell.isToday ? ' today' : ''}`
      );
      node.dataset.date = cell.key;
      const number = el('span', 'day-number');
      number.textContent = String(cell.dayNumber);
      node.appendChild(number);
      if (byDay.has(cell.key)) {
        appendTrainingChips(node, byDay.get(cell.key));
      }
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

  document.addEventListener('app:languagechange', () => {
    syncToggleButtons();
    render();
  });

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

  document.addEventListener('kinesis:preferences-changed', (event) => {
    const next = event.detail?.first_day_of_week;
    if (!SUPPORTED_WEEK_STARTS.includes(next) || next === state.firstDay) return;
    state.firstDay = next;
    saveStoredWeekStart(next);
    syncToggleButtons();
    render();
  });

  const importBtn = document.getElementById('importBtn');
  const importInput = document.getElementById('importInput');
  const importModal = document.getElementById('importModal');
  const importErrorList = document.getElementById('importErrorList');
  const importModalClose = document.getElementById('importModalClose');

  function showImportErrors(error) {
    const entries = importErrorEntries(error);
    if (!entries) {
      console.warn('calendar: ignoring import failure without error details.');
      return;
    }
    importErrorList.innerHTML = '';
    for (const issue of entries) {
      const item = document.createElement('li');
      item.textContent = t('calendar.import.rowError', {
        row: issue.row,
        col: issue.col,
        error: issue.error,
      });
      importErrorList.appendChild(item);
    }
    importModal.classList.remove('hidden');
    refreshIcons();
  }

  async function reloadTrainings() {
    state.trainings = await fetchCalendarTrainings();
    render();
  }

  async function handleImportSelection() {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;

    importBtn.disabled = true;
    importBtn.classList.add('loading');
    try {
      const result = await importTrainingsFile(file);
      await reloadTrainings();
      showShellToast(
        i18n.messages,
        'calendar.import.success.importedMany',
        'success',
        3500,
        {
          lines: [
            {
              key: result.imported === 1
                ? 'calendar.import.success.importedOne'
                : 'calendar.import.success.importedMany',
              params: { count: result.imported ?? 0 },
            },
            {
              key: result.skipped === 1
                ? 'calendar.import.success.skippedOne'
                : 'calendar.import.success.skippedMany',
              params: { count: result.skipped ?? 0 },
            },
          ],
        }
      );
    } catch (error) {
      showImportErrors(error);
    } finally {
      importBtn.disabled = false;
      importBtn.classList.remove('loading');
    }
  }

  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', handleImportSelection);
  importModalClose.addEventListener('click', () => importModal.classList.add('hidden'));
  importModal.addEventListener('click', (event) => {
    if (event.target === importModal) importModal.classList.add('hidden');
  });

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
      reloadTrainings();
      return user;
    },
  };
}

export async function initCalendar() {
  const user = await initShell({ active: 'calendar' });
  if (!user) return null;

  const activeCycle = await fetchActiveCycle();
  if (!activeCycle) {
    window.location.href = '/cycles.html';
    return null;
  }

  const page = setupCalendarPage();
  page.start(user);
  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initCalendar().catch(() => window.location.replace('/login.html'));
}
