import { formatDate, parseLocalizedDate } from './date.js';

const MONTHS = { 'pt-BR': 'pt-BR', 'en-US': 'en-US' };

function localeOf(language) {
  return typeof language === 'string' && language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en-US';
}

function dateFromIso(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
}

function isoFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function firstDayIndex(weekStart) {
  return weekStart === 'Sunday' ? 0 : 1;
}

function monthLabel(date, locale) {
  return new Intl.DateTimeFormat(MONTHS[locale], { month: 'long', year: 'numeric' }).format(date);
}

function weekdayLabel(index, locale) {
  return new Intl.DateTimeFormat(MONTHS[locale], { weekday: 'short' }).format(new Date(2024, 0, 7 + index));
}

export function createDatePicker(input, { isoInput = null, getLanguage = () => 'en-US', getWeekStart = () => 'Monday', onChange = () => {} } = {}) {
  if (!input || input.dataset.datepickerReady === 'true') return null;
  input.dataset.datepickerReady = 'true';
  input.readOnly = true;
  input.setAttribute('autocomplete', 'off');
  const wrapper = document.createElement('div');
  wrapper.className = 'date-picker';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  const icon = document.createElement('span');
  icon.className = 'date-picker-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<i data-lucide="calendar"></i>';
  wrapper.appendChild(icon);
  const popup = document.createElement('div');
  popup.className = 'date-picker-popup hidden';
  popup.setAttribute('role', 'dialog');
  wrapper.appendChild(popup);
  let visibleMonth = dateFromIso(isoInput?.value || input.dataset.iso || '') || new Date();

  function currentIso() { return isoInput ? isoInput.value : (input.dataset.iso || ''); }
  function updateValue(iso, notify = true) {
    if (isoInput) isoInput.value = iso;
    input.dataset.iso = iso;
    input.value = formatDate(iso, getLanguage());
    if (notify) onChange(iso);
  }
  function render() {
    const locale = localeOf(getLanguage());
    const start = firstDayIndex(getWeekStart());
    const monthStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
    const offset = (monthStart.getDay() - start + 7) % 7;
    const daysInMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate();
    const selected = currentIso();
    const headings = Array.from({ length: 7 }, (_, position) => weekdayLabel((start + position) % 7, locale));
    const cells = [];
    for (let index = 0; index < offset; index += 1) cells.push('<span class="date-picker-day is-empty" aria-hidden="true"></span>');
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), day);
      const iso = isoFromDate(date);
      cells.push(`<button type="button" class="date-picker-day${iso === selected ? ' is-selected' : ''}" data-date="${iso}">${day}</button>`);
    }
    const previousLabel = locale === 'pt-BR' ? 'Mês anterior' : 'Previous month';
    const nextLabel = locale === 'pt-BR' ? 'Próximo mês' : 'Next month';
    popup.innerHTML = `<div class="date-picker-toolbar"><button type="button" data-calendar-action="previous" aria-label="${previousLabel}">‹</button><strong>${monthLabel(monthStart, locale)}</strong><button type="button" data-calendar-action="next" aria-label="${nextLabel}">›</button></div><div class="date-picker-weekdays">${headings.map((label) => `<span>${label}</span>`).join('')}</div><div class="date-picker-grid">${cells.join('')}</div>`;
    input.value = formatDate(selected, getLanguage());
  }
  function close() { popup.classList.add('hidden'); }
  input.addEventListener('click', (event) => { event.stopPropagation(); render(); popup.classList.toggle('hidden'); });
  popup.addEventListener('click', (event) => {
    event.stopPropagation();
    const action = event.target.closest('[data-calendar-action]')?.dataset.calendarAction;
    if (action) { visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + (action === 'next' ? 1 : -1), 1); render(); return; }
    const day = event.target.closest('[data-date]')?.dataset.date;
    if (day) { visibleMonth = dateFromIso(day); updateValue(day); close(); }
  });
  document.addEventListener('click', (event) => { if (!wrapper.contains(event.target)) close(); });
  document.addEventListener('app:languagechange', render);
  document.addEventListener('kinesis:preferences-changed', render);
  updateValue(currentIso(), false);
  render();
  if (typeof window !== 'undefined' && window.lucide?.createIcons) window.lucide.createIcons({ nodes: [wrapper] });
  const api = { getValue: currentIso, setValue: (iso) => updateValue(iso || '', false), refresh: render, destroy: close };
  input.datePicker = api;
  return api;
}

export function readDatePickerValue(input) {
  return input?.dataset.iso || null;
}

export function setDatePickerValue(input, iso) {
  if (!input) return;
  input.dataset.iso = iso || '';
  input.value = formatDate(iso, 'en-US');
}

export { parseLocalizedDate, isoFromDate, dateFromIso };
