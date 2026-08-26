import { currentUser, signOut } from './api.js';
import {
  createI18n,
  wireLanguageSwitcher,
  translate,
} from './i18n.js';

const SIDEBAR_STORAGE_KEY = 'training-assistant:sidebar-collapsed';
const CYCLE_DEPENDENT_ITEMS = ['ai-coach', 'calendar'];
const CYCLE_REDIRECT_TO = '/cycles.html';

export const FOOTER_ELEMENT_TAG = 'footer';
export const FOOTER_CLASS_NAME = 'bottom-bar';
export const VERSION_ENDPOINT = '/api/version';
export const VERSION_FALLBACK_LABEL = 'v-.-.-';

// Sidebar order: Home (coming soon) first, then cycles, then request
// workouts, then review/log workouts. Ids and hrefs stay stable for route
// matching. Items in CYCLE_DEPENDENT_ITEMS are dynamically disabled when
// no active training cycle exists.
const NAV_ITEMS = [
  {
    id: 'dashboard',
    icon: 'layout-dashboard',
    labelKey: 'shell.nav.home',
    href: null,
    disabled: true,
  },
  {
    id: 'cycles',
    icon: 'repeat',
    labelKey: 'shell.nav.cycles',
    href: '/cycles.html',
    disabled: false,
  },
  {
    id: 'ai-coach',
    icon: 'bot',
    labelKey: 'shell.nav.requestWorkouts',
    href: '/ai-coach.html',
    disabled: false,
  },
  {
    id: 'calendar',
    icon: 'calendar-days',
    labelKey: 'shell.nav.workouts',
    href: '/calendar.html',
    disabled: false,
  },
  {
    id: 'shoes',
    icon: 'footprints',
    labelKey: 'shell.nav.shoes',
    href: '/shoes.html',
    disabled: false,
  },
];

export function readSidebarCollapsed(storage = globalThis.localStorage) {
  try {
    return storage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed, storage = globalThis.localStorage) {
  try {
    storage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    /* storage unavailable - the sidebar just won't persist */
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function icon(name) {
  const holder = document.createElement('i');
  holder.setAttribute('data-lucide', name);
  return holder;
}

export function refreshIcons() {
  try {
    if (globalThis.lucide && typeof globalThis.lucide.createIcons === 'function') {
      globalThis.lucide.createIcons();
    }
  } catch {
    /* CDN unavailable - labels still render without icons */
  }
}

export function showConfirm(message, confirmLabel, cancelLabel) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';

    const card = document.createElement('div');
    card.className = 'confirm-card';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');

    const msg = document.createElement('p');
    msg.className = 'confirm-message';
    msg.textContent = message;
    card.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.id = 'confirmCancelBtn';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-danger';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.id = 'confirmOkBtn';

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [backdrop] });

    function cleanup(result) {
      backdrop.remove();
      resolve(result);
    }

    confirmBtn.addEventListener('click', () => cleanup(true), { once: true });
    cancelBtn.addEventListener('click', () => cleanup(false), { once: true });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup(false);
    }, { once: true });
  });
}

let shellI18n = createI18n({
  persistPreference: true,
  onChange: () => document.dispatchEvent(new CustomEvent('app:languagechange')),
});

export function getShellI18n() {
  return shellI18n;
}

function buildSidebar(activeId) {
  const aside = el('aside', 'sidebar');

  const brand = el('div', 'sidebar-brand');
  brand.appendChild(icon('footprints'));
  const brandName = el('span', 'sidebar-label');
  brandName.setAttribute('data-i18n', 'app.name');
  brandName.textContent = 'Kinesis';
  brand.appendChild(brandName);
  aside.appendChild(brand);

  const nav = el('nav', 'sidebar-nav');
  nav.setAttribute('aria-label', 'Main navigation');
  nav.setAttribute('data-i18n-aria-label', 'shell.navLabel');
  for (const item of NAV_ITEMS) {
    const entry = el('a', `nav-item${item.disabled ? ' disabled' : ''}${item.id === activeId ? ' active' : ''}`);
    entry.dataset.navId = item.id;
    if (item.disabled) {
      entry.setAttribute('aria-disabled', 'true');
    } else {
      entry.href = item.href;
      if (item.id === activeId) entry.setAttribute('aria-current', 'page');
    }
    entry.appendChild(icon(item.icon));
    const label = el('span', 'nav-label sidebar-label');
    label.setAttribute('data-i18n', item.labelKey);
    entry.appendChild(label);
    if (item.disabled) {
      const chip = el('span', 'soon-chip');
      chip.setAttribute('data-i18n', 'shell.soon');
      entry.appendChild(chip);
    }
    nav.appendChild(entry);
  }
  aside.appendChild(nav);

  const footer = el('div', 'sidebar-footer');
  const toggle = el('button', 'sidebar-toggle');
  toggle.type = 'button';
  toggle.id = 'sidebarToggle';
  toggle.appendChild(icon('chevrons-left'));
  const toggleLabel = el('span', 'toggle-label sidebar-label');
  toggleLabel.setAttribute('data-i18n', 'shell.collapse');
  toggle.appendChild(toggleLabel);
  footer.appendChild(toggle);
  aside.appendChild(footer);

  return aside;
}

function buildTopbar() {
  const header = el('header', 'topbar');

  const actions = el('div', 'topbar-actions');

  const langSwitch = el('div', 'lang-switch');
  for (const [lang, text, aria] of [
    ['en-US', 'EN', 'English (US)'],
    ['pt-BR', 'PT', 'Português (Brasil)'],
  ]) {
    const button = el('button');
    button.type = 'button';
    button.dataset.lang = lang;
    button.setAttribute('aria-label', aria);
    button.textContent = text;
    langSwitch.appendChild(button);
  }
  const separator = el('span', 'sep');
  separator.textContent = '|';
  langSwitch.appendChild(separator);
  actions.appendChild(langSwitch);

  const badge = el('span', 'user-badge hidden');
  badge.id = 'userBadge';
  actions.appendChild(badge);

  // Built hidden: it only becomes visible once setUserBadge confirms a
  // session, so anonymous visitors never see a dead sign-out control.
  const logout = el('button', 'logout-btn hidden');
  logout.type = 'button';
  logout.id = 'logoutBtn';
  logout.setAttribute('data-i18n-aria-label', 'shell.logout');
  logout.appendChild(icon('log-out'));
  const label = el('span');
  label.setAttribute('data-i18n', 'shell.logout');
  label.textContent = 'Logout';
  logout.appendChild(label);
  actions.appendChild(logout);

  header.appendChild(actions);
  return header;
}

// Resolves the running app version from the backend. Any failure (offline,
// non-200, malformed payload) degrades to null so the footer can fall back.
export async function loadAppVersion(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(VERSION_ENDPOINT);
    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data?.version !== 'string' || data.version === '') return null;
    return data.version;
  } catch {
    return null;
  }
}

export function formatAppVersion(version) {
  return version ? `v${version}` : VERSION_FALLBACK_LABEL;
}

function buildBottomBar() {
  const bar = document.createElement(FOOTER_ELEMENT_TAG);
  bar.className = FOOTER_CLASS_NAME;
  const versionLabel = el('span', 'footer-version');
  versionLabel.id = 'appVersion';
  bar.appendChild(versionLabel);
  return bar;
}

function buildLayout(activeId) {
  const shellRoot = el('div', 'app-shell');
  shellRoot.appendChild(buildSidebar(activeId));

  const column = el('div', 'main-column');
  column.appendChild(buildTopbar());
  const content = el('div', 'main-content');
  column.appendChild(content);
  column.appendChild(buildBottomBar());
  shellRoot.appendChild(column);

  const main = document.querySelector('main');
  if (main) {
    content.appendChild(main);
  }

  document.body.prepend(shellRoot);
  return shellRoot;
}

function setUserBadge(user) {
  const badge = document.getElementById('userBadge');
  badge.innerHTML = '';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const strong = document.createElement('b');
  strong.textContent = name || user.email;
  badge.appendChild(strong);
  badge.classList.remove('hidden');
  // A confirmed session means the sign-out action is safe to show.
  document.getElementById('logoutBtn').classList.remove('hidden');
}

function wireLogout() {
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    const button = document.getElementById('logoutBtn');
    button.disabled = true;
    await signOut();
    window.location.replace('/login.html');
  });
}

function syncToggleState(shellRoot, collapsed) {
  shellRoot.classList.toggle('collapsed', collapsed);
  const toggle = shellRoot.querySelector('#sidebarToggle');
  toggle.setAttribute(
    'aria-label',
    translate(shellI18n.messages, collapsed ? 'shell.expand' : 'shell.collapse')
  );
  toggleLabelSync(shellRoot, collapsed);
}

function toggleLabelSync(shellRoot, collapsed) {
  const label = shellRoot.querySelector('.toggle-label');
  if (label) {
    label.setAttribute('data-i18n', collapsed ? 'shell.expand' : 'shell.collapse');
    label.textContent = translate(shellI18n.messages, collapsed ? 'shell.expand' : 'shell.collapse');
  }
  const iconHolder = shellRoot.querySelector('#sidebarToggle [data-lucide], #sidebarToggle svg[data-lucide]');
  if (iconHolder) {
    iconHolder.setAttribute('data-lucide', collapsed ? 'chevrons-right' : 'chevrons-left');
  }
}

export async function initShell({ active } = {}) {
  document.body.classList.add('shell-loading');
  const user = await currentUser();
  if (!user) {
    window.location.replace('/login.html');
    return null;
  }

  const shellRoot = buildLayout(active ?? null);
  syncToggleState(shellRoot, readSidebarCollapsed());

  await shellI18n.init(user.preferred_lang);
  syncToggleState(shellRoot, readSidebarCollapsed());
  refreshIcons();

  setUserBadge(user);
  wireLogout();

  // Check for an active training cycle and disable dependent items.
  let hasActiveCycle = false;
  try {
    const resp = await fetch('/api/cycles/active', { headers: { accept: 'application/json' } });
    if (resp.ok) {
      const data = await resp.json();
      hasActiveCycle = !!data.cycle;
    }
  } catch {
    /* offline or unauthenticated — treat as no cycle */
  }

  if (!hasActiveCycle) {
    applyCycleGuard(shellRoot);
  }

  // The footer only carries the app version; resolve it without blocking
  // the shell mount and degrade gracefully when unreachable.
  const versionLabel = shellRoot.querySelector('#appVersion');
  loadAppVersion().then((version) => {
    versionLabel.textContent = formatAppVersion(version);
  });

  shellRoot.querySelector('#sidebarToggle').addEventListener('click', () => {
    const collapsed = !shellRoot.classList.contains('collapsed');
    writeSidebarCollapsed(collapsed);
    syncToggleState(shellRoot, collapsed);
    refreshIcons();
  });

  wireLanguageSwitcher(shellI18n);

  document.body.classList.remove('shell-loading');
  document.body.classList.add('shell-mounted');
  return user;
}

export function applyCycleGuard(shellRoot) {
  const i18nKey = 'shell.noCycle';
  const fallback = 'NO ACTIVE CYCLE';
  for (const navEntry of shellRoot.querySelectorAll('.nav-item')) {
    if (CYCLE_DEPENDENT_ITEMS.includes(navEntry.dataset.navId)) {
      navEntry.classList.add('disabled');
      navEntry.setAttribute('aria-disabled', 'true');
      navEntry.removeAttribute('href');
      const chip = el('span', 'soon-chip');
      chip.setAttribute('data-i18n', i18nKey);
      const currentI18n = getShellI18n();
      if (currentI18n && currentI18n.messages) {
        chip.textContent = translate(currentI18n.messages, i18nKey) || fallback;
      } else {
        chip.textContent = fallback;
      }
      navEntry.appendChild(chip);
      navEntry.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = CYCLE_REDIRECT_TO;
      });
    }
  }
  refreshIcons();
}
