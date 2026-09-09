'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');

test('central DatePicker keeps ISO dates stable and rejects invalid calendar dates', async () => {
  const { dateFromIso, isoFromDate } = await import('../src/public/shared/datepicker.js');
  assert.equal(isoFromDate(dateFromIso('2026-09-14')), '2026-09-14');
  assert.equal(dateFromIso('2026-02-30'), null);
  assert.equal(dateFromIso(''), null);
});

test('central DatePicker defines localized display, language reactivity and week-start rendering', () => {
  const js = readFileSync(join(publicDir, 'shared', 'datepicker.js'), 'utf8');
  assert.match(js, /formatDate\(iso, getLanguage\(\)\)/);
  assert.match(js, /document\.addEventListener\('app:languagechange', render\)/);
  assert.match(js, /document\.addEventListener\('kinesis:preferences-changed', render\)/);
  assert.match(js, /firstDayIndex\(getWeekStart\(\)\)/);
  assert.match(js, /data-lucide="calendar"/);
  assert.match(js, /locale === 'pt-BR' \? 'Mês anterior' : 'Previous month'/);
  assert.match(js, /date-picker-popup/);
  assert.match(js, /popup\.addEventListener\('click', \(event\) => \{\s*event\.stopPropagation\(\)/);
  assert.match(js, /action === 'next' \? 1 : -1/);
});

test('DatePicker CSS marks the complete trigger surface as interactive', () => {
  const css = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');
  assert.match(css, /\.date-picker \{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.date-picker > input \{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.date-picker-icon \{[^}]*cursor:\s*pointer/);
});

test('DatePicker stays open while navigating months and closes after selecting a day', async () => {
  const { createDatePicker } = await import('../src/public/shared/datepicker.js');
  class FakeElement {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.dataset = {};
      this.children = [];
      this.listeners = {};
      this.attributes = {};
      this._className = '';
      this.classList = {
        values: new Set(),
        add: (...names) => names.forEach((name) => this.classList.values.add(name)),
        remove: (...names) => names.forEach((name) => this.classList.values.delete(name)),
        toggle: (name, force) => (force === undefined ? !this.classList.values.delete(name) && this.classList.values.add(name) : (force ? this.classList.values.add(name) : this.classList.values.delete(name))),
        contains: (name) => this.classList.values.has(name),
      };
      Object.defineProperty(this, 'className', {
        get: () => this._className,
        set: (value) => { this._className = value; this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean)); },
      });
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    contains(target) { return target === this || this.children.some((child) => child.contains?.(target)); }
    insertBefore(child) { this.children.push(child); child.parentNode = this; }
    closest() { return null; }
  }
  const previousDocument = global.document;
  global.document = {
    createElement: (tag) => new FakeElement(tag),
    addEventListener: () => {},
  };
  try {
    const parent = new FakeElement('div');
    const input = new FakeElement('input');
    input.parentNode = parent;
    const isoInput = new FakeElement('input');
    isoInput.value = '2026-08-14';
    const picker = createDatePicker(input, { isoInput, getLanguage: () => 'pt-BR', getWeekStart: () => 'Monday' });
    const wrapper = input.parentNode;
    const popup = wrapper.children.find((child) => child.className === 'date-picker-popup hidden');
    input.listeners.click({ stopPropagation() {} });
    assert.equal(popup.classList.contains('hidden'), false);
    const nextTarget = { closest: () => ({ dataset: { calendarAction: 'next' } }) };
    popup.listeners.click({ target: nextTarget, stopPropagation() {} });
    assert.equal(popup.classList.contains('hidden'), false);
    assert.match(popup.innerHTML, /setembro|outubro/i);
    const dayTarget = { closest: () => ({ dataset: { date: '2026-09-10' } }) };
    popup.listeners.click({ target: dayTarget, stopPropagation() {} });
    assert.equal(popup.classList.contains('hidden'), true);
    assert.equal(isoInput.value, '2026-09-10');
    picker.destroy();
  } finally {
    global.document = previousDocument;
  }
});

test('all application date entry points use the centralized picker', () => {
  const cycles = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  const coach = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');
  assert.match(cycles, /createDatePicker\(document\.getElementById\(id\)/);
  assert.match(coach, /createDatePicker\(targetDateDisplay/);
});
