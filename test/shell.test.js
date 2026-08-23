'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readSidebarCollapsed,
  writeSidebarCollapsed,
  FOOTER_ELEMENT_TAG,
  FOOTER_CLASS_NAME,
  FOOTER_STATUS_KEY,
} = require('../src/public/shared/shell.js');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

function stubStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
}

const NAV_ITEMS = [
  {
    id: 'training-result',
    labelKey: 'shell.nav.training',
    href: '/training-result.html',
    disabled: false,
    icon: 'activity',
  },
  { id: 'dashboard', labelKey: 'shell.nav.dashboard', href: null, disabled: true, icon: 'layout-dashboard' },
  { id: 'calendar', labelKey: 'shell.nav.calendar', href: '/calendar.html', disabled: false, icon: 'calendar-days' },
];

test('sidebar starts expanded when no state was ever stored', () => {
  assert.equal(readSidebarCollapsed(stubStorage()), false);
});

test('sidebar collapse state persists through the storage round-trip', () => {
  const storage = stubStorage();
  assert.equal(readSidebarCollapsed(storage), false);

  writeSidebarCollapsed(true, storage);
  assert.equal(storage.getItem('training-assistant:sidebar-collapsed'), '1');
  assert.equal(readSidebarCollapsed(storage), true);

  writeSidebarCollapsed(false, storage);
  assert.equal(storage.getItem('training-assistant:sidebar-collapsed'), '0');
  assert.equal(readSidebarCollapsed(storage), false);
});

test('sidebar state readers tolerate missing storage APIs', () => {
  assert.equal(readSidebarCollapsed(undefined), false);
  assert.equal(readSidebarCollapsed({ getItem: () => { throw new Error('boom'); } }), false);
  assert.doesNotThrow(() => writeSidebarCollapsed(true, { setItem: () => { throw new Error('boom'); } }));
  assert.doesNotThrow(() => writeSidebarCollapsed(true, undefined));
});

test('sidebar state treats anything but "1" as expanded', () => {
  assert.equal(readSidebarCollapsed(stubStorage({ 'training-assistant:sidebar-collapsed': '0' })), false);
  assert.equal(readSidebarCollapsed(stubStorage({ 'training-assistant:sidebar-collapsed': 'junk' })), false);
});

test('shell navigation config matches the phase specification', () => {
  assert.deepEqual(
    NAV_ITEMS.map((item) => [item.id, item.disabled]),
    [
      ['training-result', false],
      ['dashboard', true],
      ['calendar', false],
    ]
  );
  assert.equal(NAV_ITEMS[0].href, '/training-result.html');
  assert.equal(NAV_ITEMS[2].href, '/calendar.html');
  assert.ok(
    NAV_ITEMS.filter((item) => item.disabled).every((item) => item.href === null)
  );
});

test('every sidebar label key resolves in both locale files', () => {
  const lookup = (messages, path) =>
    path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), messages);
  const keys = [
    ...NAV_ITEMS.map((item) => item.labelKey),
    'shell.soon',
    'shell.collapse',
    'shell.expand',
    FOOTER_STATUS_KEY,
  ];
  for (const key of keys) {
    assert.equal(typeof lookup(en, key), 'string', `en.json missing ${key}`);
    assert.equal(typeof lookup(pt, key), 'string', `pt.json missing ${key}`);
  }
});

test('bottom bar is a footer element carrying the translatable status line', () => {
  assert.equal(FOOTER_ELEMENT_TAG, 'footer');
  assert.equal(FOOTER_CLASS_NAME, 'bottom-bar');
  assert.equal(FOOTER_STATUS_KEY, 'shell.footer.status');
  assert.equal(en.shell.footer.status, 'Training Assistant • Local & Offline');
  assert.equal(pt.shell.footer.status, 'Training Assistant • Local e Offline');
});
