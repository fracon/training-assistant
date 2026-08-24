import { currentUser, signOut } from './api.js';
import {
  createI18n,
  wireLanguageSwitcher,
  translate,
} from './i18n.js';

const SIDEBAR_STORAGE_KEY = 'training-assistant:sidebar-collapsed';

export const FOOTER_ELEMENT_TAG = 'footer';
export const FOOTER_CLASS_NAME = 'bottom-bar';
export const FOOTER_STATUS_KEY = 'shell.footer.status';

const NAV_ITEMS = [
  {
    id: 'training-result',
    icon: 'activity',
    labelKey: 'shell.nav.training',
    href: '/training-result.html',
    disabled: false,
  },
  {
    id: 'dashboard',
    icon: 'layout-dashboard',
    labelKey: 'shell.nav.dashboard',
    href: null,
    disabled: true,
  },
  {
    id: 'calendar',
    icon: 'calendar-days',
    labelKey: 'shell.nav.calendar',
    href: '/calendar.html',
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
  brandName.textContent = 'Training Assistant';
  brand.appendChild(brandName);
  aside.appendChild(brand);

  const nav = el('nav', 'sidebar-nav');
  nav.setAttribute('aria-label', 'Main navigation');
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

  const brand = el('span', 'brand');
  brand.textContent = 'Training Assistant';
  header.appendChild(brand);

  const dot = el('span', 'dot');
  dot.textContent = '•';
  header.appendChild(dot);

  const tagline = el('span', 'tagline');
  tagline.setAttribute('data-i18n', 'app.tagline');
  tagline.textContent = 'Local & Offline';
  header.appendChild(tagline);

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

  const logout = el('button', 'logout-btn hidden');
  logout.type = 'button';
  logout.id = 'logoutBtn';
  logout.textContent = 'Logout';
  actions.appendChild(logout);

  header.appendChild(actions);
  return header;
}

function buildBottomBar() {
  const bar = document.createElement(FOOTER_ELEMENT_TAG);
  bar.className = FOOTER_CLASS_NAME;
  const status = el('span', 'bottom-bar-status');
  status.setAttribute('data-i18n', FOOTER_STATUS_KEY);
  status.textContent = translate(shellI18n.messages, FOOTER_STATUS_KEY);
  bar.appendChild(status);
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

  const shellRoot = buildLayout(active ?? 'training-result');
  syncToggleState(shellRoot, readSidebarCollapsed());

  await shellI18n.init(user.preferred_lang);
  syncToggleState(shellRoot, readSidebarCollapsed());
  refreshIcons();

  setUserBadge(user);
  wireLogout();

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
