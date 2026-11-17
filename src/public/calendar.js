import { fetchCalendarTrainings, importTrainingsFile, fetchActiveCycle, updateTrainingDate } from './shared/api.js';
import {
  initShell,
  getShellI18n,
  getUserPreferences,
  saveUserPreferences,
  refreshIcons,
  showShellToast,
} from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate, formatCalendarDate, formatMonth } from './shared/date.js';
import { createDatePicker } from './shared/datepicker.js';
import { createDialogFocusTrap } from './shared/dialog-focus.js';

export const WEEK_START_STORAGE_KEY = 'training-assistant:first-day-of-week';
export const SUPPORTED_WEEK_STARTS = ['Monday', 'Sunday'];
export const DEFAULT_WEEK_START = 'Monday';

export function readAppliedWeek(search = globalThis.location?.search || '') {
  const value = new URLSearchParams(search).get('week') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getDay() !== 1) return null;
  return value;
}

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

// Day cells expose bare-number keys ("2026-9-7"); rescheduling must write
// back the same zero-padded ISO format the importer stores in `dia`.
export function isoFromGridKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Optimistic drag-and-drop reschedule: returns a brand-new list with the
// dropped training moved to `newIso`, or the same reference when the id is
// unknown or the training already sits on the target day.
export function rescheduledTrainings(trainings, id, newIso) {
  const targetId = String(id);
  let moved = null;
  for (const training of trainings) {
    if (String(training.id) === targetId) {
      if (training.dia === newIso) return trainings;
      moved = { ...training, dia: newIso };
      break;
    }
  }
  if (!moved) return trainings;
  return trainings.map((training) =>
    String(training.id) === targetId ? moved : training
  );
}

// Noon local civil dates avoid UTC offsets and DST changing the selected day.
export function weekDates(iso, firstDay = DEFAULT_WEEK_START) {
  const date = new Date(`${iso}T12:00:00`);
  const offset = (date.getDay() - (firstDay === 'Sunday' ? 0 : 1) + 7) % 7;
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset + index, 12);
    return isoFromGridKey(`${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`);
  });
}

export function weekGroups(trainings, iso, firstDay) {
  return weekDates(iso, firstDay).map((dia) => ({ dia, trainings: trainings.filter((training) => training.dia === dia) }))
    .filter((group) => group.trainings.length);
}

export function sessionMarkers(trainings) {
  return { planned: trainings.some((training) => !training.completed), completed: trainings.some((training) => Boolean(training.completed)) };
}

export function sessionStatus(training, t) {
  const status = t(training.completed ? 'calendar.agenda.completed' : 'calendar.agenda.planned');
  return training.feedback_rpe != null
    ? `${status} · ${t('calendar.agenda.rpe', { rpe: training.feedback_rpe })}` : status;
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
  const appliedWeek = readAppliedWeek(window.location.search);
  const displayedDate = appliedWeek ? new Date(`${appliedWeek}T12:00:00`) : now;
  const state = {
    year: displayedDate.getFullYear(),
    monthIndex: displayedDate.getMonth(),
    firstDay: DEFAULT_WEEK_START,
    trainings: [],
    selectedDate: isoFromGridKey(`${displayedDate.getFullYear()}-${displayedDate.getMonth() + 1}-${displayedDate.getDate()}`),
  };

  let i18n = null;
  const phone = window.matchMedia('(max-width: 640px)');
  const miniMonth = document.getElementById('miniMonth');
  const agenda = document.getElementById('weekAgenda');
  const moveModal = document.getElementById('moveModal');
  const moveDate = document.getElementById('moveDate');
  let moveTraining = null, moveTrigger = null;
  const picker = createDatePicker(moveDate, { getLanguage: () => i18n?.language, getWeekStart: () => state.firstDay });
  const moveTrap = createDialogFocusTrap(moveModal, closeMove);

  function closeMove() {
    picker.destroy();
    moveModal.classList.add('hidden');
    moveTrap.deactivate();
    const trigger = moveTrigger?.isConnected
      ? moveTrigger : agenda.querySelector(`[data-training-id="${moveTraining?.id}"] .agenda-move`);
    (phone.matches ? trigger || miniMonth.querySelector('[tabindex="0"]') : prevBtn)?.focus();
    moveTraining = null;
    moveTrigger = null;
  }

  function openMove(training, trigger) {
    moveTraining = training;
    moveTrigger = trigger;
    document.getElementById('moveTrainingTitle').textContent = training.treino || training.tipo;
    picker.setValue(training.dia);
    moveModal.classList.remove('hidden');
    moveTrap.activate();
    document.getElementById('moveTitle').focus();
  }

  document.getElementById('moveCancel').addEventListener('click', closeMove);
  moveModal.addEventListener('click', (event) => { if (event.target === moveModal) closeMove(); });
  document.getElementById('moveForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const id = moveTraining?.id;
    const iso = picker.getValue();
    if (!id || !iso) return;
    closeMove();
    rescheduleTraining(id, iso);
  });

  function selectMonthWeek() {
    const todayInMonth = now.getFullYear() === state.year && now.getMonth() === state.monthIndex;
    state.selectedDate = isoFromGridKey(`${state.year}-${state.monthIndex + 1}-${todayInMonth ? now.getDate() : 1}`);
  }

  function renderAgenda() {
    const selectedWeek = weekDates(state.selectedDate, state.firstDay);
    const byDay = trainingsByDay(state.trainings);
    miniMonth.replaceChildren();
    for (const jsDay of weekdayOrder(state.firstDay)) {
      const header = el('span', 'weekday-head');
      header.textContent = t(`calendar.weekdaysShort.${weekdayArrayIndex(jsDay)}`).slice(0, 1);
      header.setAttribute('aria-hidden', 'true');
      miniMonth.append(header);
    }
    const cells = buildCalendarCells(state.year, state.monthIndex, state.firstDay);
    cells.forEach((cell, index) => {
      const iso = isoFromGridKey(cell.key);
      const sessions = byDay.get(cell.key) || [];
      const button = el('button', `mini-day${cell.inMonth ? '' : ' outside'}`);
      button.type = 'button';
      button.dataset.date = iso;
      button.tabIndex = iso === state.selectedDate ? 0 : -1;
      button.setAttribute('aria-label', `${formatCalendarDate(iso, i18n.language)} · ${t(sessions.length === 1 ? 'calendar.agenda.sessionOne' : 'calendar.agenda.sessionMany', { count: sessions.length })}`);
      button.setAttribute('aria-pressed', String(selectedWeek.includes(iso)));
      if (cell.isToday) button.setAttribute('aria-current', 'date');
      const number = el('span');
      number.textContent = String(cell.dayNumber);
      button.append(number);
      const markers = el('span', 'session-markers');
      markers.setAttribute('aria-hidden', 'true');
      for (const [status, present] of Object.entries(sessionMarkers(sessions))) {
        if (present) markers.append(el('i', `session-dot ${status}`));
      }
      button.append(markers);
      button.addEventListener('click', () => {
        state.selectedDate = iso;
        render();
        miniMonth.querySelector(`[data-date="${iso}"]`)?.focus();
      });
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          button.click();
          return;
        }
        const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
        if (!delta) return;
        event.preventDefault();
        const target = miniMonth.querySelectorAll('button')[index + delta];
        if (target) {
          miniMonth.querySelectorAll('button').forEach((day) => { day.tabIndex = -1; });
          target.tabIndex = 0;
          target.focus();
        }
      });
      miniMonth.append(button);
    });
    document.getElementById('agendaWeekTitle').textContent = t('calendar.agenda.weekRange', {
      start: formatDate(selectedWeek[0], i18n.language), end: formatDate(selectedWeek[6], i18n.language),
    });
    agenda.replaceChildren();
    const groups = weekGroups(state.trainings, state.selectedDate, state.firstDay);
    if (!groups.length) {
      const empty = el('p', 'agenda-empty');
      empty.textContent = t('calendar.agenda.empty');
      agenda.append(empty);
    }
    for (const group of groups) {
      const section = el('section', 'agenda-day');
      const heading = el('h3');
      heading.textContent = formatCalendarDate(group.dia, i18n.language, 'short');
      section.append(heading);
      for (const training of group.trainings) {
        const card = el('article', 'agenda-card');
        card.dataset.trainingId = training.id;
        const link = el('a', 'agenda-card-body');
        link.href = trainingResultUrl(training.id);
        const type = el('span', 'agenda-type');
        type.textContent = training.tipo;
        const title = el('strong', 'agenda-title');
        // Spreadsheet imports may carry only the type.
        title.textContent = training.treino || training.tipo;
        const details = el('span', 'agenda-details');
        details.textContent = training.detalhes;
        const status = el('span', `agenda-status${training.completed ? ' completed' : ''}`);
        status.textContent = sessionStatus(training, t);
        link.append(type, title, details, status);
        const move = el('button', 'btn-icon agenda-move');
        move.type = 'button';
        move.setAttribute('aria-label', t('calendar.move.label', { title: training.treino || training.tipo }));
        move.innerHTML = '<i data-lucide="calendar-arrow-up"></i>';
        const tooltip = el('span', 'custom-tooltip');
        tooltip.textContent = t('calendar.move.title');
        move.append(tooltip);
        move.addEventListener('click', () => openMove(training, move));
        card.append(link, move);
        section.append(card);
      }
      agenda.append(section);
    }
    refreshIcons();
  }

  phone.addEventListener('change', () => {
    if (!moveModal.classList.contains('hidden')) closeMove();
    render();
  });

  function t(key, params) {
    return translate(i18n ? i18n.messages : {}, key, params);
  }

  function containTooltip(anchor, tooltip) {
    anchor.addEventListener('mouseenter', () => {
      tooltip.style.marginLeft = '0px';
      tooltip.style.marginTop = '0px';
      const bounds = grid.closest('.main-content')?.getBoundingClientRect();
      const left = Math.max(0, bounds?.left || 0) + 8;
      const right = Math.min(innerWidth, bounds?.right || innerWidth) - 16;
      const top = Math.max(0, bounds?.top || 0) + 8;
      const rect = tooltip.getBoundingClientRect();
      tooltip.style.marginLeft = `${Math.max(left - rect.left, Math.min(0, right - rect.right))}px`;
      tooltip.style.marginTop = `${Math.max(0, top - rect.top)}px`;
    });
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
        containTooltip(chip, tooltip);
      }
      chip.dataset.trainingId = String(training.id);
      chip.addEventListener('click', () => {
        window.location.href = trainingResultUrl(training.id);
      });
      chip.draggable = true;
      chip.setAttribute('aria-grabbed', 'false');
      chip.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', String(training.id));
        chip.classList.add('dragging');
        chip.setAttribute('aria-grabbed', 'true');
      });
      chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
        chip.setAttribute('aria-grabbed', 'false');
      });
      cellNode.appendChild(chip);
    }
    if (dayTrainings.length > visible.length) {
      const more = el('span', 'training-chip chip-more');
      more.textContent = `+${dayTrainings.length - visible.length}`;
      const moreTooltip = el('div', 'custom-tooltip');
      moreTooltip.textContent = t('calendar.moreTooltip');
      more.appendChild(moreTooltip);
      containTooltip(more, moreTooltip);
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
    // Retarget only focus that belonged to this view before replacing its nodes.
    const focused = document.activeElement;
    const focusedDate = focused?.closest('.mini-day')?.dataset.date;
    const focusedTraining = focused?.closest('.agenda-card')?.dataset.trainingId;
    const focusedMove = focused?.classList.contains('agenda-move');
    monthTitle.textContent = `${phone.matches ? formatMonth(state.monthIndex + 1, i18n.language, 'short') : t(`calendar.months.${state.monthIndex}`)} ${state.year}`;
    if (statusEl) {
      statusEl.textContent = monthTitle.textContent;
    }

    grid.inert = phone.matches;
    document.getElementById('phoneCalendar').inert = !phone.matches;
    renderAgenda();
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
      node.addEventListener('dragover', (event) => {
        event.preventDefault();
        node.classList.add('drag-over');
      });
      node.addEventListener('dragleave', (event) => {
        if (!event.relatedTarget || !node.contains(event.relatedTarget)) {
          node.classList.remove('drag-over');
        }
      });
      node.addEventListener('drop', (event) => {
        event.preventDefault();
        node.classList.remove('drag-over');
        const trainingId = event.dataTransfer.getData('text/plain');
        if (trainingId) {
          handleRescheduleDrop(trainingId, cell.key);
        }
      });
      if (byDay.has(cell.key)) {
        appendTrainingChips(node, byDay.get(cell.key));
      }
      node.setAttribute(
        'aria-label',
        `${longNames[weekdayArrayIndex(cell.date.getDay())]} ${cell.dayNumber} ${t(`calendar.months.${cell.date.getMonth()}`)} ${cell.date.getFullYear()}`
      );
      grid.appendChild(node);
    }
    if (focusedDate || focusedTraining) {
      const target = phone.matches
        ? (focusedDate ? miniMonth.querySelector(`[data-date="${focusedDate}"]`)
          : agenda.querySelector(`[data-training-id="${focusedTraining}"] ${focusedMove ? '.agenda-move' : 'a'}`))
          || miniMonth.querySelector('[tabindex="0"]')
        : prevBtn;
      if (target?.classList.contains('mini-day')) {
        miniMonth.querySelectorAll('button').forEach((day) => { day.tabIndex = day === target ? 0 : -1; });
      }
      target?.focus({ preventScroll: true });
    }
  }

  async function applyWeekStart(next) {
    if (!SUPPORTED_WEEK_STARTS.includes(next) || next === state.firstDay) return;
    state.firstDay = next;
    picker.refresh();
    saveStoredWeekStart(next);
    syncToggleButtons();
    render();
    try {
      await saveUserPreferences({
        ...getUserPreferences(),
        first_day_of_week: next,
      });
    } catch {
      /* offline - keep rendering with the local preference */
    }
  }

  mondayBtn.addEventListener('click', () => applyWeekStart('Monday'));
  sundayBtn.addEventListener('click', () => applyWeekStart('Sunday'));

  document.addEventListener('app:languagechange', () => {
    picker.setValue(picker.getValue());
    picker.refresh();
    syncToggleButtons();
    render();
  });

  prevBtn.addEventListener('click', () => {
    state.monthIndex -= 1;
    if (state.monthIndex < 0) {
      state.monthIndex = 11;
      state.year -= 1;
    }
    selectMonthWeek();
    render();
  });

  nextBtn.addEventListener('click', () => {
    state.monthIndex += 1;
    if (state.monthIndex > 11) {
      state.monthIndex = 0;
      state.year += 1;
    }
    selectMonthWeek();
    render();
  });

  document.addEventListener('kinesis:preferences-changed', (event) => {
    const next = event.detail?.first_day_of_week;
    if (!SUPPORTED_WEEK_STARTS.includes(next) || next === state.firstDay) return;
    state.firstDay = next;
    picker.refresh();
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

  function handleRescheduleDrop(trainingId, cellKey) {
    const newIso = isoFromGridKey(cellKey);
    return rescheduleTraining(trainingId, newIso);
  }

  async function rescheduleTraining(trainingId, newIso) {
    const moved = rescheduledTrainings(state.trainings, trainingId, newIso);
    if (moved === state.trainings) return;
    state.trainings = moved;
    render();
    try {
      await updateTrainingDate(trainingId, newIso);
      showShellToast(
        i18n.messages,
        'calendar.reschedule.success',
        'success',
        2500,
        { date: formatDate(newIso, i18n.language) }
      );
    } catch {
      await reloadTrainings();
      showShellToast(i18n.messages, 'calendar.reschedule.error', 'error', 3000);
    }
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
      if (appliedWeek) {
        const params = new URLSearchParams(window.location.search);
        params.delete('week');
        const query = params.toString();
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
      }
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
