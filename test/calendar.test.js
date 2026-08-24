'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WEEK_START_STORAGE_KEY,
  SUPPORTED_WEEK_STARTS,
  DEFAULT_WEEK_START,
  normalizeClientWeekStart,
  readStoredWeekStart,
  saveStoredWeekStart,
  syncStoredWeekStartFromUser,
  weekdayOrder,
  weekdayArrayIndex,
  buildCalendarCells,
} = require('../src/public/calendar.js');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

function stubStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
}

test('client week-start constants match the backend contract', () => {
  assert.deepEqual(SUPPORTED_WEEK_STARTS, ['Monday', 'Sunday']);
  assert.equal(DEFAULT_WEEK_START, 'Monday');
});

test('normalizeClientWeekStart accepts only exact supported values', () => {
  assert.equal(normalizeClientWeekStart('junk', 'Sunday', 'Monday'), 'Sunday');
  assert.equal(normalizeClientWeekStart(null, undefined), 'Monday');
  assert.equal(normalizeClientWeekStart('monday'), 'Monday', 'case-sensitive by design');
});

test('stored week start round-trips and tolerates broken storage', () => {
  const storage = stubStorage();
  assert.equal(readStoredWeekStart(storage), null);

  saveStoredWeekStart('Sunday', storage);
  assert.equal(storage.getItem(WEEK_START_STORAGE_KEY), 'Sunday');
  assert.equal(readStoredWeekStart(storage), 'Sunday');

  saveStoredWeekStart('Monday', storage);
  assert.equal(readStoredWeekStart(storage), 'Monday');

  assert.equal(readStoredWeekStart(undefined), null);
  assert.equal(
    readStoredWeekStart({ getItem: () => { throw new Error('boom'); } }),
    null
  );
  assert.doesNotThrow(() => saveStoredWeekStart('Monday', { setItem: () => { throw new Error('boom'); } }));
  assert.doesNotThrow(() => syncStoredWeekStartFromUser(null));
  assert.equal(syncStoredWeekStartFromUser({ first_day_of_week: 'Funday' }), false);
});

test('syncStoredWeekStartFromUser mirrors a valid preference into storage', () => {
  const storage = stubStorage();
  assert.equal(syncStoredWeekStartFromUser({ first_day_of_week: 'Sunday' }, storage), true);
  assert.equal(storage.getItem(WEEK_START_STORAGE_KEY), 'Sunday');

  assert.equal(syncStoredWeekStartFromUser({ first_day_of_week: 'Monday' }, storage), true);
  assert.equal(storage.getItem(WEEK_START_STORAGE_KEY), 'Monday');

  assert.equal(syncStoredWeekStartFromUser({}, storage), false);
});

test('weekday order honors the Monday default and Sunday option', () => {
  assert.deepEqual(weekdayOrder('Monday'), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(weekdayOrder('Sunday'), [0, 1, 2, 3, 4, 5, 6]);
});

test('weekdayArrayIndex converts getDay values to monday-indexed locale arrays', () => {
  assert.equal(weekdayArrayIndex(0), 6, 'Sunday is the last slot of locale arrays');
  assert.equal(weekdayArrayIndex(1), 0, 'Monday opens locale arrays');
  assert.equal(weekdayArrayIndex(2), 1);
  assert.equal(weekdayArrayIndex(4), 3);
  assert.equal(weekdayArrayIndex(6), 5);
});

function headerLabelsFor(firstDay, messages = en) {
  return weekdayOrder(firstDay).map(
    (jsDay) => messages.calendar.weekdaysShort[weekdayArrayIndex(jsDay)]
  );
}

test('grid headers re-index instantly when the week start toggles', () => {
  assert.deepEqual(headerLabelsFor('Monday'), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.deepEqual(headerLabelsFor('Sunday'), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

  assert.deepEqual(headerLabelsFor('Monday', pt), ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']);
  assert.deepEqual(headerLabelsFor('Sunday', pt), ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']);
});

test('every august 2026 cell sits in the column matching its weekday', () => {
  for (const firstDay of ['Monday', 'Sunday']) {
    const cells = buildCalendarCells(2026, 7, firstDay);
    cells.forEach((cell, position) => {
      assert.equal(
        weekdayOrder(firstDay)[position % 7],
        cell.date.getDay(),
        `${firstDay} column ${position % 7} vs ${cell.key}`
      );
    });
  }
});

test('august 23 2026 (a sunday) renders under the Sun header in both modes', () => {
  assert.equal(new Date(2026, 7, 23).getDay(), 0, 'the reported date is a Sunday');

  for (const firstDay of ['Monday', 'Sunday']) {
    const cells = buildCalendarCells(2026, 7, firstDay);
    const position = cells.findIndex((cell) => cell.key === '2026-8-23');
    const columnIndex = position % 7;

    assert.equal(weekdayOrder(firstDay)[columnIndex], 0);
    assert.equal(headerLabelsFor(firstDay)[columnIndex], 'Sun');
    assert.equal(headerLabelsFor(firstDay, pt)[columnIndex], 'Dom');
    assert.equal(cells[position].inMonth, true);
  }

  const mondayFirst = buildCalendarCells(2026, 7, 'Monday');
  assert.equal(mondayFirst.findIndex((cell) => cell.key === '2026-8-23') % 7, 6, 'last column');
  const sundayFirst = buildCalendarCells(2026, 7, 'Sunday');
  assert.equal(sundayFirst.findIndex((cell) => cell.key === '2026-8-23') % 7, 0, 'first column');
});

test('buildCalendarCells renders a Monday-first month grid', () => {
  // January 2026 starts on a Thursday; Monday-first grid needs 3 leading blanks.
  const cells = buildCalendarCells(2026, 0, 'Monday', new Date(2026, 5, 15));
  assert.equal(cells.length, 42);
  assert.deepEqual(cells.slice(0, 3).map((cell) => cell.inMonth), [false, false, false]);
  assert.deepEqual(cells.slice(0, 3).map((cell) => cell.dayNumber), [29, 30, 31]);
  assert.equal(cells[3].dayNumber, 1);
  assert.equal(cells[3].inMonth, true);
  assert.equal(cells[3].date.getDay(), 4);

  const lastJanuaryDay = cells[33];
  assert.equal(lastJanuaryDay.dayNumber, 31);
  assert.equal(lastJanuaryDay.inMonth, true);
  assert.deepEqual(cells.slice(34).map((cell) => cell.inMonth), [
    false, false, false, false, false, false, false, false,
  ]);
  assert.ok(cells.every((cell) => cell.isToday === false));

  const keys = new Set(cells.map((cell) => cell.key));
  assert.equal(keys.size, 42);
  assert.ok(keys.has('2026-1-31'));
  assert.ok(keys.has('2026-2-1'));
});

test('buildCalendarCells shifts leading blanks for Sunday-first grids', () => {
  // January 2026 starts on Thursday: Sunday-first needs 4 leading blanks.
  const cells = buildCalendarCells(2026, 0, 'Sunday', new Date(2026, 5, 15));
  assert.equal(cells.length, 42);
  assert.equal(cells[0].dayNumber, 28);
  assert.deepEqual(cells.slice(0, 4).map((cell) => cell.inMonth), [false, false, false, false]);
  assert.equal(cells[4].dayNumber, 1);
  assert.equal(cells[4].inMonth, true);
});

test('buildCalendarCells flags today inside and outside the month', () => {
  const inMonth = buildCalendarCells(2026, 0, 'Monday', new Date(2026, 0, 15));
  const flagged = inMonth.filter((cell) => cell.isToday);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].dayNumber, 15);
  assert.equal(flagged[0].inMonth, true);

  const outside = buildCalendarCells(2026, 1, 'Monday', new Date(2026, 0, 15));
  assert.equal(outside.filter((cell) => cell.isToday).length, 0);
});

test('buildCalendarCells handles leap-year February', () => {
  const cells = buildCalendarCells(2024, 1, 'Monday', new Date(2026, 5, 15));
  const februaryDays = cells.filter((cell) => cell.inMonth).map((cell) => cell.dayNumber);
  assert.equal(februaryDays.length, 29);
  assert.ok(februaryDays.includes(29));
});

test('calendar locale data is complete and parity-safe', () => {
  for (const messages of [en, pt]) {
    assert.equal(messages.calendar.months.length, 12);
    assert.equal(messages.calendar.weekdaysShort.length, 7);
    assert.equal(messages.calendar.weekdaysLong.length, 7);
    assert.equal(typeof messages.calendar.firstDayLabel, 'string');
    assert.equal(messages.calendar.weekStart.Monday.length > 0, true);
    assert.equal(messages.calendar.weekStart.Sunday.length > 0, true);
    assert.ok(messages.calendar.title);
    assert.ok(messages.calendar.previousMonth);
    assert.ok(messages.calendar.nextMonth);
    assert.ok(messages.calendar.today);
  }

  assert.equal(en.calendar.months[0], 'January');
  assert.equal(pt.calendar.months[0], 'Janeiro');
  assert.equal(en.calendar.weekdaysShort[0], 'Mon');
  assert.equal(pt.calendar.weekdaysShort[0], 'Seg');
});
