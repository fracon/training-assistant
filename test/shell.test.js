'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  readSidebarCollapsed,
  writeSidebarCollapsed,
  FOOTER_ELEMENT_TAG,
  FOOTER_CLASS_NAME,
  VERSION_FALLBACK_LABEL,
  loadAppVersion,
  formatAppVersion,
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
  { id: 'dashboard', labelKey: 'shell.nav.dashboard', href: null, disabled: true, icon: 'layout-dashboard' },
  { id: 'calendar', labelKey: 'shell.nav.calendar', href: '/calendar.html', disabled: false, icon: 'calendar-days' },
  { id: 'ai-coach', labelKey: 'shell.nav.aiCoach', href: '/ai-coach.html', disabled: false, icon: 'bot' },
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
      ['dashboard', true],
      ['calendar', false],
      ['ai-coach', false],
    ]
  );
  assert.equal(NAV_ITEMS[1].href, '/calendar.html');
  assert.equal(NAV_ITEMS[2].href, '/ai-coach.html');
  assert.ok(
    NAV_ITEMS.filter((item) => item.disabled).every((item) => item.href === null)
  );
});

test('training-result is contextual only and absent from the sidebar', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.ok(!js.includes("'training-result'"), 'no training-result nav entry remains');
  assert.ok(!js.includes('/training-result.html'), 'the shell never links the session page');
  assert.ok(js.includes("buildLayout(active ?? null)"), 'unknown active ids simply highlight nothing');
});

test('every sidebar label key resolves in both locale files', () => {
  const lookup = (messages, path) =>
    path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), messages);
  const keys = [
    ...NAV_ITEMS.map((item) => item.labelKey),
    'shell.soon',
    'shell.collapse',
    'shell.expand',
    'shell.navLabel',
    'shell.logout',
  ];
  for (const key of keys) {
    assert.equal(typeof lookup(en, key), 'string', `en.json missing ${key}`);
    assert.equal(typeof lookup(pt, key), 'string', `pt.json missing ${key}`);
  }
});

test('the footer carries only the app version, fetched from the backend', async () => {
  assert.equal(FOOTER_ELEMENT_TAG, 'footer');
  assert.equal(FOOTER_CLASS_NAME, 'bottom-bar');

  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.ok(!js.includes('shell.footer.status'), 'the old status key is gone from the shell');
  assert.ok(!js.includes("addEventListener('online'"), 'no network status listeners remain');
  assert.ok(!js.includes("addEventListener('offline'"), 'no network status listeners remain');
  assert.match(
    js,
    /const versionLabel = shellRoot\.querySelector\('#appVersion'\);/,
    'the footer renders a dedicated version span'
  );
  assert.match(
    js,
    /loadAppVersion\(\)\.then\(\(version\) => \{\s*\n\s*versionLabel\.textContent = formatAppVersion\(version\);\s*\n\s*\}\);/,
    'the fetched version lands in the footer without blocking the mount'
  );

  assert.equal(en.shell.footer, undefined);
  assert.equal(pt.shell.footer, undefined);

  const css = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.css'), 'utf8');
  assert.match(css, /\.footer-version \{[^}]*font-weight:\s*600/, 'the version label stays subtle');
});

test('loadAppVersion resolves the packaged version and degrades to null on any failure', async () => {
  const ok = (body) => async () => ({ ok: true, json: async () => body });
  assert.equal(await loadAppVersion(ok({ version: '1.0.0' })), '1.0.0');
  assert.equal(await loadAppVersion(async () => ({ ok: false, json: async () => ({ version: '1.0.0' }) })), null);
  assert.equal(await loadAppVersion(ok({})), null, 'a malformed payload is treated as missing');
  assert.equal(await loadAppVersion(ok({ version: '' })), null);
  assert.equal(await loadAppVersion(ok({ version: 42 })), null);
  assert.equal(await loadAppVersion(undefined), null, 'an unreachable backend falls back gracefully');
});

test('formatAppVersion prefixes the fetched version and falls back to v-.-.-', () => {
  assert.equal(formatAppVersion('2.3.1'), 'v2.3.1');
  assert.equal(formatAppVersion(null), VERSION_FALLBACK_LABEL);
  assert.equal(formatAppVersion(''), VERSION_FALLBACK_LABEL);
  assert.equal(VERSION_FALLBACK_LABEL, 'v-.-.-');
});

test('the brand lives only in the sidebar as Kinesis', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');

  assert.ok(!js.includes('Training Assistant'), 'the old name is gone from the shell');
  assert.match(
    js,
    /brandName\.setAttribute\('data-i18n', 'app\.name'\);/,
    'the sidebar brand resolves through translations'
  );
  assert.match(js, /brandName\.textContent = 'Kinesis';/, 'Kinesis is the pre-translation fallback');
  assert.ok(!js.includes("el('span', 'brand')"), 'no topbar brand span is built anymore');
  assert.ok(!js.includes("el('span', 'dot')"), 'the brand dot separator is gone');
  assert.ok(!js.includes("el('span', 'tagline')"), 'the topbar tagline is gone');

  const css = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.css'), 'utf8');
  assert.match(
    css,
    /\.topbar \{[^}]*justify-content:\s*flex-end/,
    'action-only topbar hugs the right edge'
  );
  assert.match(css, /\.topbar \{[^}]*min-height:\s*2\.75rem/, 'the bar keeps its height without text flow');

  assert.equal(en.app.name, 'Kinesis');
  assert.equal(pt.app.name, 'Kinesis');
});

test('shell chrome strings are translated and wired through i18n attributes', () => {
  assert.equal(en.shell.navLabel, 'Main navigation');
  assert.equal(pt.shell.navLabel, 'Navegação principal');
  assert.equal(en.shell.logout, 'Logout');
  assert.equal(pt.shell.logout, 'Sair');

  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /setAttribute\('data-i18n-aria-label', 'shell\.navLabel'\);/);
  assert.match(js, /setAttribute\('data-i18n', 'shell\.logout'\);/);
});
