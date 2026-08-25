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
  { id: 'dashboard', labelKey: 'shell.nav.home', href: null, disabled: true, icon: 'layout-dashboard' },
  { id: 'ai-coach', labelKey: 'shell.nav.requestWorkouts', href: '/ai-coach.html', disabled: false, icon: 'bot' },
  { id: 'calendar', labelKey: 'shell.nav.workouts', href: '/calendar.html', disabled: false, icon: 'calendar-days' },
  { id: 'shoes', labelKey: 'shell.nav.shoes', href: '/shoes.html', disabled: false, icon: 'footprints' },
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

test('sidebar navigation follows Home, Request Workouts, Workouts, Shoes', () => {
  assert.deepEqual(
    NAV_ITEMS.map((item) => item.id),
    ['dashboard', 'ai-coach', 'calendar', 'shoes'],
    'Home placeholder first, then request workouts, then workouts, then shoes'
  );
  assert.deepEqual(
    NAV_ITEMS.map((item) => [item.id, item.disabled]),
    [
      ['dashboard', true],
      ['ai-coach', false],
      ['calendar', false],
      ['shoes', false],
    ]
  );
  assert.equal(NAV_ITEMS[0].href, null, 'the Home badge item stays a coming-soon placeholder');
  assert.equal(NAV_ITEMS[1].href, '/ai-coach.html');
  assert.equal(NAV_ITEMS[2].href, '/calendar.html');
  assert.equal(NAV_ITEMS[3].href, '/shoes.html');
  assert.ok(
    NAV_ITEMS.filter((item) => item.disabled).every((item) => item.href === null)
  );
  assert.equal(en.shell.nav.home, 'Home');
  assert.equal(pt.shell.nav.home, 'Início');
  assert.equal(en.shell.nav.requestWorkouts, 'Request Workouts');
  assert.equal(pt.shell.nav.requestWorkouts, 'Solicitar Treinos');
  assert.equal(en.shell.nav.workouts, 'Workouts');
  assert.equal(pt.shell.nav.workouts, 'Treinos');
  assert.equal(en.shell.nav.shoes, 'Shoes');
  assert.equal(pt.shell.nav.shoes, 'Tênis');
  assert.equal(en.shell.confirm.yes, 'Delete');
  assert.equal(pt.shell.confirm.yes, 'Excluir');
  assert.equal(en.shell.confirm.no, 'Cancel');
  assert.equal(pt.shell.confirm.no, 'Cancelar');
  assert.equal(en.shell.nav.dashboard, undefined);
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
    'shell.confirm.yes',
    'shell.confirm.no',
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

test('the topbar restores a working logout action once authenticated', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');

  assert.match(
    js,
    /const logout = el\('button', 'logout-btn hidden'\);/,
    'the button starts hidden so anonymous visitors never see it'
  );
  assert.match(
    js,
    /logout\.id = 'logoutBtn';[\s\S]*?logout\.appendChild\(icon\('log-out'\)\);[\s\S]*?label\.setAttribute\('data-i18n', 'shell\.logout'\);/,
    'the log-out icon renders directly before the translated label'
  );
  assert.match(
    js,
    /logout\.setAttribute\('data-i18n-aria-label', 'shell\.logout'\);/,
    'the action stays accessible through translations'
  );
  assert.match(
    js,
    /badge\.classList\.remove\('hidden'\);\s*\n\s*\/\/ A confirmed session means the sign-out action is safe to show\.\s*\n\s*document\.getElementById\('logoutBtn'\)\.classList\.remove\('hidden'\);/,
    'a confirmed session reveals the previously invisible button'
  );
  assert.match(
    js,
    /wireLogout\(\);/,
    'the click wiring runs on every mount'
  );
  assert.match(
    js,
    /await signOut\(\);\s*\n\s*window\.location\.replace\('\/login\.html'\);/,
    'clicking clears the session and returns to the login screen'
  );

  assert.match(
    js,
    /actions\.appendChild\(badge\);[\s\S]*?actions\.appendChild\(logout\);\s*\n\s*header\.appendChild\(actions\);/,
    'the logout pill is the last action, hugging the far right of the header'
  );

  const shellCss = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.css'), 'utf8');
  assert.match(shellCss, /\.topbar \{[^}]*justify-content:\s*flex-end/, 'the action cluster hugs the right edge');

  const theme = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'theme.css'), 'utf8');
  assert.match(
    theme,
    /\.logout-btn \{[^}]*display:\s*inline-flex;\s*\n\s*align-items:\s*center;\s*\n\s*gap:\s*0\.4rem/,
    'icon and label stay perfectly centered'
  );
  assert.match(theme, /\.logout-btn svg \{[^}]*width:\s*14px/, 'the icon is sized to the compact pill');
});

test('showConfirm is exported and builds a Promise-based confirmation dialog', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /export function showConfirm\(/);
  assert.match(js, /return new Promise/);
  assert.match(js, /confirm-backdrop/);
  assert.match(js, /confirm-card/);
  assert.match(js, /confirm-message/);
  assert.match(js, /confirmOkBtn/);
  assert.match(js, /confirmCancelBtn/);
  assert.match(js, /setAttribute\('role', 'alertdialog'\)/);
  assert.match(js, /cleanup\(true\)/);
  assert.match(js, /cleanup\(false\)/);
});

test('confirm modal CSS matches the Kinesis design system', () => {
  const theme = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'theme.css'), 'utf8');
  assert.match(theme, /\.confirm-backdrop \{[^}]*position:\s*fixed/);
  assert.match(theme, /\.confirm-backdrop \{[^}]*z-index:\s*9998/);
  assert.match(theme, /\.confirm-card \{[^}]*border-radius:\s*16px/);
  assert.match(theme, /\.confirm-card \{[^}]*background:\s*var\(--card\)/);
  assert.match(theme, /\.btn-danger \{[^}]*background:\s*var\(--danger\)/);
  assert.match(theme, /\.btn-danger \{[^}]*transition:\s*all 0\.2s ease/);
});
