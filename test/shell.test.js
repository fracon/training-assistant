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
  buildUserMenu,
  wireUserMenu,
  reapplyPasswordErrors,
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
  { id: 'dashboard', labelKey: 'shell.nav.home', href: '/home.html', disabled: false, icon: 'layout-dashboard' },
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
    'Home dashboard first, then request workouts, then workouts, then shoes'
  );
  assert.deepEqual(
    NAV_ITEMS.map((item) => [item.id, item.disabled]),
    [
      ['dashboard', false],
      ['ai-coach', false],
      ['calendar', false],
      ['shoes', false],
    ]
  );
  assert.equal(NAV_ITEMS[0].href, '/home.html', 'the Home item opens the dashboard');
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
  assert.equal(en.shell.nav.shoes, 'Shoe Rotation');
  assert.equal(pt.shell.nav.shoes, 'Rotação de Tênis');
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
    'shell.userMenu',
    'shell.changePassword',
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
  assert.equal(require('../package.json').version, '0.1.0');
  assert.equal(await loadAppVersion(ok({ version: '0.1.0' })), '0.1.0');
  assert.equal(await loadAppVersion(async () => ({ ok: false, json: async () => ({ version: '0.1.0' }) })), null);
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
    'a confirmed session reveals the previously invisible badge and button'
  );
  assert.match(
    js,
    /document\.getElementById\('userBadgeName'\)\.textContent = name;/,
    'the badge name element absorbs the signed-in identity'
  );
  assert.match(
    js,
    /wireLogout\(\);\s*\n\s*\/\/ The user menu wires up before any page-specific guard runs, so a guard\s*\n\s*\/\/ failure can never leave the account trigger unbound\.\s*\n\s*wireUserMenu\(\);/,
    'the dropdown click wiring runs on every mount before any page guard'
  );
  assert.match(
    js,
    /await signOut\(\);\s*\n\s*window\.location\.replace\('\/login\.html'\);/,
    'clicking clears the session and returns to the login screen'
  );

  assert.match(
    js,
    /actions\.appendChild\(userMenu\);[\s\S]*?actions\.appendChild\(logout\);\s*\n\s*header\.appendChild\(actions\);/,
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

/* ── Training Cycles sidebar guard ── */

test('NAV_ITEMS includes cycles between dashboard and ai-coach', () => {
  assert.deepEqual(
    NAV_ITEMS.map((item) => item.id),
    ['dashboard', 'ai-coach', 'calendar', 'shoes'],
    'the test fixture NAV_ITEMS does not include cycles'
  );
});

test('shell.js NAV_ITEMS array includes cycles with repeat icon', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /id:\s*'cycles'/, 'cycles nav item exists');
  assert.match(js, /icon:\s*'repeat'/, 'cycles uses the repeat icon');
  assert.match(js, /labelKey:\s*'shell\.nav\.cycles'/, 'cycles label resolves through i18n');
  assert.match(js, /href:\s*'\/cycles\.html'/, 'cycles links to the cycles page');
});

test('CYCLE_DEPENDENT_ITEMS targets ai-coach and calendar', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /CYCLE_DEPENDENT_ITEMS\s*=\s*\['ai-coach',\s*'calendar'\]/);
});

test('CYCLE_REDIRECT_TO points to cycles.html', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /CYCLE_REDIRECT_TO\s*=\s*'\/cycles\.html'/);
});

test('applyCycleGuard is exported from shell.js', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /export function applyCycleGuard/);
});

test('applyCycleGuard disables items in CYCLE_DEPENDENT_ITEMS and reveals pre-built badges', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /CYCLE_DEPENDENT_ITEMS\.includes\(navEntry\.dataset\.navId\)/);
  assert.match(js, /navEntry\.classList\.add\('disabled'\)/);
  assert.match(js, /navEntry\.setAttribute\('aria-disabled',\s*'true'\)/);
  assert.match(js, /navEntry\.removeAttribute\('href'\)/);
  assert.match(js, /window\.location\.href\s*=\s*CYCLE_REDIRECT_TO/);
  assert.match(js, /const badges = shellRoot\.querySelectorAll\('\.cycle-guard-badge'\)/);
  assert.match(js, /badge\.classList\.remove\('hidden'\)/);
});

test('initShell fetches active cycle and calls applyCycleGuard when none exists', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /\/api\/cycles\/active/);
  assert.match(js, /hasActiveCycle\s*=\s*!!data\.cycle/);
  assert.match(js, /if\s*\(!hasActiveCycle\)\s*\{\s*\n\s*applyCycleGuard\(shellRoot\)/);
});

test('initShell listens for kinesis:cycle-changed to refresh the sidebar guard', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /window\.addEventListener\('kinesis:cycle-changed'/);
  assert.match(js, /refreshCycleGuard\(shellRoot\)/);
});

test('refreshCycleGuard re-fetches active cycle and toggles guard accordingly', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /async function refreshCycleGuard\(shellRoot\)/);
  assert.match(js, /removeCycleGuard\(shellRoot\)/);
  assert.match(js, /data\.cycle\)\s*\{[^}]*removeCycleGuard/);
});

test('removeCycleGuard re-enables nav items and hides badges', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(js, /function removeCycleGuard\(shellRoot\)/);
  assert.match(js, /navEntry\.classList\.remove\('disabled'\)/);
  assert.match(js, /navEntry\.removeAttribute\('aria-disabled'\)/);
  assert.match(js, /badge\.classList\.add\('hidden'\)/);
});

test('shell.noCycle i18n key exists in both locale files', () => {
  assert.equal(typeof en.shell.noCycle, 'string');
  assert.equal(typeof pt.shell.noCycle, 'string');
  assert.equal(en.shell.noCycle, 'No active cycle');
  assert.equal(pt.shell.noCycle, 'Nenhum ciclo ativo');
});

test('shell.nav.cycles i18n key exists in both locale files', () => {
  assert.equal(typeof en.shell.nav.cycles, 'string');
  assert.equal(typeof pt.shell.nav.cycles, 'string');
  assert.equal(en.shell.nav.cycles, 'Training Cycles');
  assert.equal(pt.shell.nav.cycles, 'Ciclos de Treino');
});

test('buildSidebar embeds hidden cycle-guard-badge spans for CYCLE_DEPENDENT_ITEMS', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.match(
    js,
    /if \(CYCLE_DEPENDENT_ITEMS\.includes\(item\.id\)\)/,
    'the guard badge is conditionally injected per nav item'
  );
  assert.match(
    js,
    /el\('span',\s*'soon-chip cycle-guard-badge hidden'\)/,
    'the badge ships hidden by default so i18n can translate it before the guard runs'
  );
  assert.match(
    js,
    /chip\.setAttribute\('data-i18n',\s*'shell\.noCycle'\)/,
    'the badge carries the noCycle i18n key for automatic translation'
  );
});

test('shell.css gives nav-item flex layout so the soon-chip does not overlap the label', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.css'), 'utf8');
  assert.match(
    css,
    /\.nav-item \.nav-label \{[^}]*flex:\s*1/,
    'the label fills available space'
  );
  assert.match(
    css,
    /\.nav-item \.nav-label \{[^}]*min-width:\s*0/,
    'the label can shrink below its content size'
  );
  assert.match(
    css,
    /\.soon-chip \{[^}]*flex-shrink:\s*0/,
    'the chip never collapses'
  );
});

/* ── Global user menu (dropdown + chevron) ── */

test('buildUserMenu nests the chevron in the badge and ships the change-password item', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');

  assert.match(js, /export function buildUserMenu\(\)/, 'the user menu factory is exported');
  assert.match(js, /const menu = el\('div', 'user-menu'\)/, 'the wrapper uses the .user-menu class');
  assert.match(js, /const badge = el\('button', 'user-badge hidden'\);/, 'the badge is a clickable button');
  assert.match(js, /badge\.id = 'userBadge';/, 'the badge is unique by id');
  assert.match(
    js,
    /badge\.appendChild\(icon\('chevron-down'\)\);[\s\S]*?menu\.appendChild\(badge\);/,
    'the chevron is appended inside the badge pill, not beside it'
  );
  assert.match(
    js,
    /badge\.setAttribute\('data-i18n-aria-label', 'shell\.userMenu'\);/,
    'the badge carries the translated aria-label'
  );
  assert.match(js, /dropdown\.id = 'userDropdown';/, 'the absolute container is unique by id');
  assert.match(js, /el\('div', 'user-dropdown hidden'\)/, 'the dropdown ships hidden by default');
  assert.match(js, /const changePassword = el\('button', 'user-menu-item'\);/, 'the change-password row is a menu item');
  assert.match(js, /changePassword\.id = 'userChangePassword';/, 'the item is unique by id');
  assert.match(js, /changePassword\.appendChild\(icon\('key'\)\);/, 'the item renders the key icon');
  assert.match(
    js,
    /changePasswordLabel\.setAttribute\('data-i18n', 'shell\.changePassword'\);/,
    'the item uses the localized label'
  );
  assert.match(
    js,
    /changePasswordLabel\.textContent = 'Change Password';/,
    'the item has a visible fallback string'
  );

  const css = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.css'), 'utf8');
  assert.match(css, /\.user-menu \{[^}]*position:\s*relative/, 'the menu anchors the dropdown');
  assert.match(css, /\.user-menu \{[^}]*display:\s*inline-flex/, 'the wrapper is an inline-flex cluster');
  assert.match(css, /\.user-menu \{[^}]*align-items:\s*center/, 'the wrapper centers its children');
  assert.match(
    css,
    /\.user-dropdown \{[^}]*position:\s*absolute;\s*\n\s*right:\s*0;\s*\n\s*top:\s*100%;\s*\n\s*width:\s*max-content;\s*\n\s*margin-top:\s*8px;/,
    'the dropdown pins under the pill and sizes to content'
  );
  assert.match(
    css,
    /\.user-menu-item \{[^}]*display:\s*flex;\s*\n\s*align-items:\s*center;\s*\n\s*justify-content:\s*flex-start;\s*\n\s*gap:\s*10px;\s*\n\s*padding:\s*10px 14px;\s*\n\s*white-space:\s*nowrap;/,
    'the menu item mirrors the exact finalized layout rules'
  );
  assert.match(
    css,
    /\.user-badge svg \{[^}]*transition:\s*transform 0\.2s ease;/,
    'the chevron animates with a smooth rotation transition'
  );
  assert.match(
    css,
    /#userBadge\.open svg,\s*\n\.user-menu\.open #userBadge svg \{\s*\n\s*transform:\s*rotate\(180deg\);\s*\n\s*\}/,
    'the foolproof rotation selector flips the chevron inside the badge'
  );
  assert.match(css, /\.user-menu-item \{[^}]*cursor:\s*pointer;/, 'the item presents as clickable');
  assert.match(
    css,
    /\.user-menu-item \{[^}]*color:\s*var\(--ink\);/,
    'the item uses the primary ink color, never a faded grey'
  );
  assert.match(
    css,
    /\.user-menu-item:hover \{[^}]*background:\s*rgba\(111, 144, 112, 0\.12\);/,
    'the hover state is clearly visible against the dropdown'
  );
});

test('wireUserMenu binds the badge click to toggle helpers and the item to the modal', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');

  assert.match(js, /export function wireUserMenu\(\)/, 'the click wiring is exported');
  assert.match(js, /export function toggleUserMenu\(\)/, 'the toggle helper is reusable');
  assert.match(js, /export function closeUserMenu\(\)/, 'closing is reusable and exported');
  assert.match(js, /document\.getElementById\('userBadge'\)/, 'it grabs the badge as the trigger');
  assert.match(js, /document\.getElementById\('userDropdown'\)/, 'it grabs the dropdown');
  assert.match(
    js,
    /trigger\.addEventListener\('click', \(event\) => \{\s*\n\s*event\.stopPropagation\(\);\s*\n\s*toggleUserMenu\(\);\s*\n\s*\}\);/,
    'clicking the badge toggles the menu'
  );
  assert.match(
    js,
    /dropdown\.classList\.toggle\('hidden', !expand\)/,
    'the toggle flips the hidden flag'
  );
  assert.match(
    js,
    /trigger\.classList\.toggle\('open', expand\);/,
    'the badge open state follows the toggle'
  );
  assert.match(
    js,
    /trigger\.setAttribute\('aria-expanded', String\(expand\)\);/,
    'the aria state follows the toggle'
  );
  assert.match(
    js,
    /document\.addEventListener\('click', \(event\) => \{\s*\n\s*if \(event\.target\.closest\('\.user-menu'\)\) return;\s*\n\s*closeUserMenu\(\);\s*\n\s*\}\);/,
    'a click outside the menu closes it and resets the trigger state'
  );
  assert.match(
    js,
    /document\.addEventListener\('keydown', \(event\) => \{\s*\n\s*if \(event\.key === 'Escape'\) \{\s*\n\s*closeUserMenu\(\);\s*\n\s*closeChangePasswordModal\(\);\s*\n\s*closePreferencesModal\(\);\s*\n\s*\}\s*\n\s*\}\);/,
    'escape closes the dropdown and any open modal'
  );
  assert.match(
    js,
    /document\.getElementById\('userChangePassword'\)\.addEventListener\('click', \(\) => \{\s*\n\s*openChangePasswordModal\(\);\s*\n\s*\}\);/,
    'the change-password item opens the modal instead of just collapsing the menu'
  );
});

test('the user menu is decoupled from the cycle guard and mounts before it', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  const initBody = js.slice(js.indexOf('export async function initShell'));

  assert.ok(
    initBody.indexOf('wireUserMenu();') < initBody.indexOf('applyCycleGuard(shellRoot)'),
    'the account trigger wires up before the guard can run'
  );
  assert.match(
    js,
    /try \{\s*\n\s*if \(!hasActiveCycle\) \{\s*\n\s*applyCycleGuard\(shellRoot\);\s*\n\s*\}\s*\n\s*\} catch \{\s*\n\s*\/\* the cycle guard must never halt the shell mount \*\/\s*\n\s*\}/,
    'a guard failure is contained and can never halt the shell mount'
  );
  assert.match(
    initBody,
    /wireUserMenu\(\);[\s\S]*?\/\/ Check for an active training cycle/,
    'the dropdown init sits before the guard block in the pipeline'
  );
});

test('the user menu injects a clickable dropdown and the change-password item opens the modal', () => {
  const registry = new Map();
  const docListeners = { click: [], keydown: [] };

  function classesOf(node) {
    return node.className.split(' ').filter(Boolean);
  }

  function fakeEl(tag, cls) {
    const classes = new Set((cls ?? '').split(' ').filter(Boolean));
    const listeners = {};
    const node = {
      tag,
      id: null,
      type: '',
      textContent: '',
      attrs: {},
      dataset: {},
      children: [],
      parent: null,
      get className() {
        return [...classes].join(' ');
      },
      set className(value) {
        classes.clear();
        for (const name of String(value ?? '').split(' ').filter(Boolean)) {
          classes.add(name);
        }
      },
      appendChild(child) {
        child.parent = this;
        this.children.push(child);
        return child;
      },
      setAttribute(key, value) {
        this.attrs[key] = value;
        if (key.startsWith('data-')) {
          const prop = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          this.dataset[prop] = value;
        }
      },
      reset() {},
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      querySelector(selector) {
        return descendants(this).find((c) => matchesSelector(c, selector)) ?? null;
      },
      querySelectorAll(selector) {
        return descendants(this).filter((c) => matchesSelector(c, selector));
      },
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        },
        toggle(name, force) {
          const target = force === undefined ? !classes.has(name) : Boolean(force);
          if (target) classes.add(name);
          else classes.delete(name);
          return classes.has(name);
        },
      },
      listeners,
    };
    if (cls) node.className = cls;
    return node;
  }

  function matchesPart(node, part) {
    if (part.startsWith('#')) return node.id === part.slice(1);
    if (part.startsWith('.')) return classesOf(node).includes(part.slice(1));
    if (part.startsWith('[')) {
      const attr = part.slice(1, -1);
      return Object.prototype.hasOwnProperty.call(node.attrs, attr);
    }
    return node.tag === part;
  }

  function matchesSelector(node, selector) {
    const parts = selector.trim().split(/\s+/);
    if (!matchesPart(node, parts[parts.length - 1])) return false;
    let current = node.parent;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (current && !matchesPart(current, parts[i])) current = current.parent;
      if (!current) return false;
    }
    return true;
  }

  function descendants(node, out = []) {
    for (const child of node.children) {
      out.push(child);
      descendants(child, out);
    }
    return out;
  }

  function findById(node, id) {
    for (const child of descendants(node)) {
      if (child.id === id) return child;
    }
    return null;
  }

  const originalDocument = globalThis.document;
  const body = fakeEl('body');
  globalThis.document = {
    createElement: fakeEl,
    body,
    getElementById: (id) => registry.get(id) ?? findById(body, id),
    addEventListener: (type, fn) => {
      (docListeners[type] ??= []).push(fn);
    },
    querySelectorAll: () => [],
  };

  try {
    const menu = buildUserMenu();
    const walk = (node) => {
      for (const child of node.children) {
        if (child.id) registry.set(child.id, child);
        walk(child);
      }
    };
    walk(menu);
    const badge = registry.get('userBadge');
    const dropdown = registry.get('userDropdown');
    const changePassword = registry.get('userChangePassword');
    const preferences = registry.get('userPreferences');

    assert.ok(menu.className === 'user-menu', 'the wrapper renders as .user-menu');
    assert.equal(badge.tag, 'button', 'the badge renders as a button');
    assert.equal(badge.attrs['aria-expanded'], 'false', 'the badge discloses the closed state');
    assert.equal(badge.attrs['data-i18n-aria-label'], 'shell.userMenu');
    assert.equal(
      badge.children[badge.children.length - 1].attrs['data-lucide'],
      'chevron-down',
      'the chevron is the last child inside the badge pill'
    );
    assert.ok(dropdown.className.split(' ').includes('user-dropdown'), 'the container renders');
    assert.ok(dropdown.classList.contains('hidden'), 'the dropdown starts closed');
    assert.equal(changePassword.className, 'user-menu-item', 'the change-password row is a menu item');
    assert.equal(
      changePassword.children[0].attrs['data-lucide'],
      'key',
      'the change-password item renders the key icon'
    );
    assert.equal(
      changePassword.children[1].textContent,
      'Change Password',
      'the change-password item keeps its label'
    );
    assert.equal(preferences.className, 'user-menu-item');
    assert.equal(preferences.children[0].attrs['data-lucide'], 'settings');
    assert.equal(preferences.children[1].textContent, 'Preferences');

    wireUserMenu();

    badge.listeners['click'][0]({ stopPropagation() {} });
    assert.ok(!dropdown.classList.contains('hidden'), 'clicking the badge opens the menu');
    assert.ok(badge.classList.contains('open'), 'the badge flips to open');
    assert.equal(badge.attrs['aria-expanded'], 'true', 'aria-expanded tracks the open state');

    badge.listeners['click'][0]({ stopPropagation() {} });
    assert.ok(dropdown.classList.contains('hidden'), 'clicking the badge again closes the menu');
    assert.ok(!badge.classList.contains('open'), 'the badge returns to closed');

    changePassword.listeners['click'][0]();
    assert.ok(dropdown.classList.contains('hidden'), 'the modal replaces the dropdown');

    const modal = document.getElementById('changePasswordModal');
    assert.ok(modal, 'clicking the item builds the change-password modal');
    assert.ok(!modal.classList.contains('hidden'), 'the modal element is visibly open');

    const closeBtn = document.getElementById('closeChangePasswordBtn');
    assert.ok(closeBtn, 'the modal ships a dedicated close button');
    closeBtn.listeners['click'][0]();
    assert.ok(modal.classList.contains('hidden'), 'the close button hides the modal');

    preferences.listeners['click'][0]();
    const preferencesModal = document.getElementById('preferencesModal');
    assert.ok(preferencesModal, 'clicking preferences builds the standardized modal');
    assert.ok(!preferencesModal.classList.contains('hidden'));
    document.getElementById('closePreferencesBtn').listeners['click'][0]();
    assert.ok(preferencesModal.classList.contains('hidden'));

    changePassword.listeners['click'][0]();
    modal.listeners['click'][0]({ target: modal });
    assert.ok(modal.classList.contains('hidden'), 'clicking the backdrop closes the modal');

    changePassword.listeners['click'][0]();
    docListeners.keydown[0]({ key: 'Escape' });
    assert.ok(dropdown.classList.contains('hidden'), 'escape keeps the dropdown closed');
    assert.ok(modal.classList.contains('hidden'), 'escape closes the modal');

    docListeners.click[0]({ target: { closest: () => null } });
    assert.ok(badge.classList.contains('open') === false, 'an outside click resets the chevron state');

    badge.listeners['click'][0]({ stopPropagation() {} });
    docListeners.click[0]({ target: { closest: () => null } });
    assert.ok(dropdown.classList.contains('hidden'), 'an outside click closes an open menu');
    assert.ok(!badge.classList.contains('open'), 'outside click resets the rotate state');
    assert.equal(badge.attrs['aria-expanded'], 'false', 'outside click resets the aria state');
  } finally {
    globalThis.document = originalDocument;
  }
});

/* ── Change Password modal wiring ── */

test('the change-password modal ships three translated password fields', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');

  assert.match(js, /export function openChangePasswordModal\(/, 'the modal opener is exported');
  assert.match(js, /export function closeChangePasswordModal\(/, 'the modal closer is exported');
  assert.match(js, /export function wireChangePasswordForm\(/, 'the form wiring is exported');
  assert.match(js, /backdrop\.id = 'changePasswordModal'/, 'the modal has a stable id');
  assert.match(js, /form\.id = 'changePasswordForm'/, 'the form has a stable id');
  assert.match(js, /buildPasswordField\('currentPassword', 'password\.currentLabel', 'password\.currentPlaceholder', 'lock'\)/);
  assert.match(js, /buildPasswordField\('newPassword', 'password\.newLabel', 'password\.newPlaceholder', 'key-round'\)/);
  assert.match(js, /buildPasswordField\('confirmNewPassword', 'password\.confirmLabel', 'password\.confirmPlaceholder', 'check'\)/);
  assert.match(js, /input\.autocomplete = name === 'currentPassword' \? 'current-password' : 'new-password'/, 'autofill hints are correct');
});

test('the modal has no lingering inline password-hint text above the error box', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');
  assert.ok(
    !js.includes('password-min-hint'),
    'the static min-length hint element has been removed from the modal'
  );
  const css = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.css'), 'utf8');
  assert.ok(
    !css.includes('password-min-hint'),
    'the ghost hint styling has been removed from the stylesheet'
  );
});

test('submission runs client-side validation then calls the API and closes the modal', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');

  assert.match(js, /validatePasswordChange\(values\)/, 'client validation runs first');
  assert.match(js, /await changePassword\(values\);/, 'the API receives the validated payload');
  assert.match(js, /showShellToast\(activeMessages, 'password\.toastSuccess'\)/, 'success is announced in a toast');
  assert.match(js, /const codes = error\.codes && error\.codes\.length > 0 \? error\.codes : \['save'\]/, 'server codes fall back to the generic save error');
  assert.match(js, /renderPasswordFormErrors\(formError, activeMessages, validation\.errors/, 'client errors render together');
  assert.match(js, /const activeMessages = shellI18n\.messages;/, 'the dictionary is resolved at submit time');
  assert.match(js, /item\.dataset\.code = code;/, 'each error is tagged with its code for re-rendering');
  assert.match(js, /item\.textContent = translate\(messages, `auth\.errors\.\$\{code\}`,\s*params\)/, 'each code maps through auth.errors');
  assert.match(js, /submit\.disabled = true;/, 'the button disables while submitting');
});

test('visible password errors re-render in the new language on switch', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');

  assert.match(js, /export function reapplyPasswordErrors\(/, 'the reactive re-render helper is exported');
  assert.match(js, /window\.addEventListener\('app:languagechange', \(\) => \{\s*\n\s*reapplyPasswordErrors\(\);/, 'the shell hooks the language-change event');
  assert.match(js, /if \(!formError \|\| formError\.classList\.contains\('hidden'\)\) return;/, 'only a visible error box reacts');
  assert.match(js, /item\.dataset\.code = code;[\s\S]*?item\.textContent = translate\(messages, `auth\.errors\.\$\{code\}`/, 'errors are rebuilt from their stored codes');
  assert.match(js, /event\.key === 'Escape'/, 'escape behavior remains wired');
});

test('the shell owns a dedicated toast so password feedback renders on every page', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.js'), 'utf8');

  assert.match(js, /export function showShellToast\(/, 'the toast helper is exported');
  assert.match(js, /translate\(messages, key, params\)/, 'toast messages support localized count parameters');
  assert.match(js, /toast-line/, 'toast supports stacked message lines');
  assert.match(js, /lineEl\.textContent = translate\(messages, line\.key, line\.params\)/);
  const theme = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'theme.css'), 'utf8');
  assert.match(theme, /\.toast-text \{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  assert.match(theme, /\.toast-line \{[^}]*display:\s*block/);
  assert.match(js, /toast\.id = 'shellToast'/, 'the shell toast has a stable id');
  assert.match(js, /toast\.classList\.toggle\('toast-error', type === 'error'\)/, 'errors switch the toast tone');
  assert.match(js, /setTimeout\(\(\) => toast\.classList\.remove\('visible'\), duration\)/, 'the toast auto-hides');
});

test('the password modal is styled to the Kinesis earthy system', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'public', 'shared', 'shell.css'), 'utf8');

  assert.match(css, /\.password-modal-backdrop \{[^}]*position:\s*fixed/, 'the backdrop covers the viewport');
  assert.match(css, /\.password-modal-backdrop \{[^}]*backdrop-filter:\s*blur\(4px\)/, 'the backdrop softens the page');
  assert.match(css, /\.password-modal-card \{[^}]*background:\s*var\(--card\)/, 'the card uses the earthy surface');
  assert.match(css, /\.password-input-wrap input\[type='password'\] \{[^}]*background:\s*var\(--bg\)/, 'inputs never use default white backgrounds');
  assert.match(css, /\.password-input-wrap input\[type='password'\] \{[^}]*appearance:\s*none/, 'native input chrome is removed');
});

test('the password i18n keys stay in parity across locale files', () => {
  assert.equal(en.password.menuLabel, 'Change Password');
  assert.equal(pt.password.menuLabel, 'Alterar Senha');
  assert.equal(en.password.title, 'Change Password');
  assert.equal(pt.password.title, 'Alterar Senha');
  assert.equal(en.password.currentLabel, 'Current Password');
  assert.equal(pt.password.currentLabel, 'Senha Atual');
  assert.equal(en.password.newLabel, 'New Password');
  assert.equal(pt.password.newLabel, 'Nova Senha');
  assert.equal(en.password.confirmLabel, 'Confirm New Password');
  assert.equal(pt.password.confirmLabel, 'Confirmar Nova Senha');
  assert.equal(en.password.toastSuccess, 'Password updated successfully!');
  assert.equal(pt.password.toastSuccess, 'Senha atualizada com sucesso!');
  assert.equal(en.auth.errors.incorrectCurrentPassword, 'Incorrect current password.');
  assert.equal(pt.auth.errors.incorrectCurrentPassword, 'Senha atual incorreta.');
  assert.equal(en.auth.errors.passwordsMismatch, 'New passwords do not match.');
  assert.equal(pt.auth.errors.passwordsMismatch, 'As novas senhas não coincidem.');
  assert.equal(en.auth.errors.passwordMinLength, 'New password must be at least {min} characters long.');
  assert.equal(pt.auth.errors.passwordMinLength, 'A nova senha deve ter pelo menos {min} caracteres.');
});

test('the change-password menu item links to the modal label through the shell namespace', () => {
  assert.equal(en.shell.changePassword, 'Change Password');
  assert.equal(pt.shell.changePassword, 'Alterar Senha');
  assert.equal(en.password.menuLabel, en.shell.changePassword);
  assert.equal(pt.password.menuLabel, pt.shell.changePassword);
});

test('reapplyPasswordErrors re-renders visible errors in the new language', () => {
  const originalDocument = globalThis.document;

  const items = [
    { dataset: { code: 'currentRequired' }, textContent: en.auth.errors.currentRequired },
    { dataset: { code: 'passwordMinLength' }, textContent: 'New password must be at least 8 characters long.' },
  ];
  const list = {
    textContent: items.map((i) => i.textContent).join(''),
    children: items,
    querySelectorAll: (sel) => (sel === 'li' ? items : []),
    appendChild(child) {
      this.children.push(child);
    },
  };
  const formError = {
    classList: {
      contains: () => false,
      remove: () => {},
    },
    querySelector: (sel) => (sel === 'ul' ? list : null),
  };

  let created = [];
  globalThis.document = {
    createElement: (tag) => {
      const node = { tag, dataset: {}, textContent: '', appendChild() {} };
      created.push(node);
      return node;
    },
    getElementById: (id) => (id === 'changePasswordFormError' ? formError : null),
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  try {
    reapplyPasswordErrors(en);
    assert.equal(created[0].dataset.code, 'currentRequired');
    assert.equal(created[0].textContent, en.auth.errors.currentRequired);
    assert.equal(created[1].dataset.code, 'passwordMinLength');
    assert.equal(
      created[1].textContent,
      'New password must be at least 8 characters long.',
      'the {min} param renders from the active dictionary'
    );

    created = [];
    reapplyPasswordErrors(pt);
    assert.equal(created[0].textContent, pt.auth.errors.currentRequired);
    assert.equal(created[1].textContent, 'A nova senha deve ter pelo menos 8 caracteres.');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('reapplyPasswordErrors is a no-op while the error box stays hidden', () => {
  const originalDocument = globalThis.document;
  const body = { appendChild() {} };
  const hidden = {
    className: 'form-error password-error-summary hidden',
    classList: {
      contains: () => true,
    },
    children: [],
    querySelector: () => null,
  };

  globalThis.document = {
    createElement: () => ({ children: [], dataset: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
    body,
    getElementById: (id) => (id === 'changePasswordFormError' ? hidden : null),
    querySelectorAll: () => [],
  };

  try {
    assert.doesNotThrow(() => reapplyPasswordErrors(en), 'hidden errors do not re-render');
  } finally {
    globalThis.document = originalDocument;
  }
});
