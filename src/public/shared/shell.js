import { currentUser, signOut, changePassword, updateUserPreferences } from './api.js';
import {
  createI18n,
  wireLanguageSwitcher,
  translate,
} from './i18n.js';
import { validatePasswordChange, MIN_PASSWORD_LENGTH } from './validators.js';
import {
  DEFAULT_USER_PREFERENCES,
  normalizeUserPreferences,
  readUserPreferences,
  writeUserPreferences,
} from './preferences.js';

const SIDEBAR_STORAGE_KEY = 'training-assistant:sidebar-collapsed';
const CYCLE_DEPENDENT_ITEMS = ['ai-coach', 'calendar'];
const CYCLE_REDIRECT_TO = '/cycles.html';

export const FOOTER_ELEMENT_TAG = 'footer';
export const FOOTER_CLASS_NAME = 'bottom-bar';
export const VERSION_ENDPOINT = '/api/version';
export const VERSION_FALLBACK_LABEL = 'v-.-.-';

// Sidebar order: Home first, then cycles, then request workouts, then
// review/log workouts. Ids and hrefs stay stable for route matching. Items
// in CYCLE_DEPENDENT_ITEMS are dynamically disabled when no active training
// cycle exists.
const NAV_ITEMS = [
  {
    id: 'dashboard',
    icon: 'layout-dashboard',
    labelKey: 'shell.nav.home',
    href: '/home.html',
    disabled: false,
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

let userPreferences = { ...DEFAULT_USER_PREFERENCES };

export function getUserPreferences() {
  return { ...userPreferences };
}

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
    if (CYCLE_DEPENDENT_ITEMS.includes(item.id)) {
      const chip = el('span', 'soon-chip cycle-guard-badge hidden');
      chip.setAttribute('data-i18n', 'shell.noCycle');
      entry.appendChild(chip);
    }
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

// The user menu is a self-contained shell component: the chevron trigger
// and its absolute dropdown are built here, completely decoupled from
// page-specific concerns like the training-cycle guard. It therefore
// initializes on every route regardless of guard outcomes.
export function buildUserMenu() {
  const menu = el('div', 'user-menu');
  const badge = el('button', 'user-badge hidden');
  badge.id = 'userBadge';
  badge.type = 'button';
  badge.setAttribute('aria-label', 'Account menu');
  badge.setAttribute('data-i18n-aria-label', 'shell.userMenu');
  badge.setAttribute('aria-expanded', 'false');
  const name = el('b');
  name.id = 'userBadgeName';
  badge.appendChild(name);
  // The chevron lives inside the badge pill so the indicator and the name
  // form a single cohesive clickable unit.
  badge.appendChild(icon('chevron-down'));
  menu.appendChild(badge);
  const dropdown = el('div', 'user-dropdown hidden');
  dropdown.id = 'userDropdown';
  const changePassword = el('button', 'user-menu-item');
  changePassword.type = 'button';
  changePassword.id = 'userChangePassword';
  changePassword.appendChild(icon('key'));
  const changePasswordLabel = el('span');
  changePasswordLabel.setAttribute('data-i18n', 'shell.changePassword');
  changePasswordLabel.textContent = 'Change Password';
  changePassword.appendChild(changePasswordLabel);
  dropdown.appendChild(changePassword);
  const preferences = el('button', 'user-menu-item');
  preferences.type = 'button';
  preferences.id = 'userPreferences';
  preferences.appendChild(icon('settings'));
  const preferencesLabel = el('span');
  preferencesLabel.setAttribute('data-i18n', 'shell.preferences');
  preferencesLabel.textContent = 'Preferences';
  preferences.appendChild(preferencesLabel);
  dropdown.appendChild(preferences);
  menu.appendChild(dropdown);
  return menu;
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

  const userMenu = buildUserMenu();
  actions.appendChild(userMenu);

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
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
  document.getElementById('userBadgeName').textContent = name;
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

let passwordToastTimer = null;

// The shell owns a dedicated toast so password feedback renders on every
// page, regardless of whether the page ships its own #toast element.
function ensureShellToast() {
  let toast = document.getElementById('shellToast');
  if (toast) return toast;
  toast = el('div', 'toast');
  toast.id = 'shellToast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  const iconWrap = el('span', 'toast-icon');
  iconWrap.innerHTML = '<i data-lucide="check-circle"></i>';
  toast.appendChild(iconWrap);
  toast.appendChild(el('span', 'toast-text'));
  document.body.appendChild(toast);
  return toast;
}

export function showShellToast(messages, key, type = 'success', duration = 2500, params) {
  const toast = ensureShellToast();
  const iconName = type === 'error' ? 'x-circle' : 'check-circle';
  const iconEl = toast.querySelector('.toast-icon');
  if (iconEl) iconEl.innerHTML = `<i data-lucide="${iconName}"></i>`;
  const textEl = toast.querySelector('.toast-text');
  if (textEl) {
    textEl.textContent = '';
    if (Array.isArray(params?.lines)) {
      for (const line of params.lines) {
        const lineEl = el('span', 'toast-line');
        lineEl.textContent = translate(messages, line.key, line.params);
        textEl.appendChild(lineEl);
      }
    } else {
      textEl.textContent = translate(messages, key, params);
    }
  }
  toast.classList.toggle('toast-error', type === 'error');
  toast.classList.add('visible');
  refreshIcons();
  clearTimeout(passwordToastTimer);
  passwordToastTimer = setTimeout(() => toast.classList.remove('visible'), duration);
}

function buildPasswordField(name, labelKey, placeholderKey, lucideName) {
  const field = el('div', 'field');
  const label = el('label', 'field-label');
  label.htmlFor = `changePassword${name[0].toUpperCase()}${name.slice(1)}`;
  label.setAttribute('data-i18n', labelKey);
  field.appendChild(label);
  const wrap = el('div', 'password-input-wrap');
  wrap.appendChild(icon(lucideName));
  const input = document.createElement('input');
  input.type = 'password';
  input.id = `changePassword${name[0].toUpperCase()}${name.slice(1)}`;
  input.name = name;
  input.autocomplete = name === 'currentPassword' ? 'current-password' : 'new-password';
  input.setAttribute('data-i18n-placeholder', placeholderKey);
  input.required = true;
  wrap.appendChild(input);
  field.appendChild(wrap);
  return field;
}

function translateAll(root, messages) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    const paramsRaw = node.dataset.i18nParams;
    const params = paramsRaw === undefined ? undefined : { min: Number(paramsRaw) };
    node.textContent = translate(messages, node.dataset.i18n, params);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.placeholder = translate(messages, node.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
    node.setAttribute('aria-label', translate(messages, node.dataset.i18nAriaLabel));
  });
}

export function openChangePasswordModal(messages = shellI18n.messages) {
  closeUserMenu();
  const existing = document.getElementById('changePasswordModal');
  if (existing) {
    existing.classList.remove('hidden');
    translateAll(existing, messages);
    refreshIcons();
    return;
  }

  const backdrop = el('div', 'modal-backdrop password-modal-backdrop');
  backdrop.id = 'changePasswordModal';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const card = el('div', 'modal-card password-modal-card');
  card.setAttribute('role', 'document');

  const header = el('div', 'modal-header');
  const title = el('h2');
  title.setAttribute('data-i18n', 'password.title');
  title.textContent = translate(messages, 'password.title');
  const close = el('button', 'modal-close');
  close.type = 'button';
  close.id = 'closeChangePasswordBtn';
  close.setAttribute('data-i18n-aria-label', 'password.title');
  close.setAttribute('aria-label', translate(messages, 'password.title'));
  close.appendChild(icon('x'));
  header.appendChild(title);
  header.appendChild(close);
  card.appendChild(header);

  const form = el('form', 'password-form');
  form.id = 'changePasswordForm';
  form.noValidate = true;
  form.appendChild(
    buildPasswordField('currentPassword', 'password.currentLabel', 'password.currentPlaceholder', 'lock')
  );
  form.appendChild(
    buildPasswordField('newPassword', 'password.newLabel', 'password.newPlaceholder', 'key-round')
  );
  form.appendChild(
    buildPasswordField('confirmNewPassword', 'password.confirmLabel', 'password.confirmPlaceholder', 'check')
  );

  const formError = el('div', 'form-error password-error-summary hidden');
  formError.id = 'changePasswordFormError';
  formError.setAttribute('role', 'alert');
  const errorList = el('ul');
  errorList.id = 'changePasswordErrorList';
  formError.appendChild(errorList);
  form.appendChild(formError);

  const actions = el('div', 'form-actions');
  const submit = el('button', 'btn-primary');
  submit.type = 'submit';
  submit.id = 'changePasswordSubmit';
  submit.appendChild(icon('key-round'));
  const submitLabel = el('span');
  submitLabel.setAttribute('data-i18n', 'password.submit');
  submitLabel.textContent = translate(messages, 'password.submit');
  submit.appendChild(submitLabel);
  actions.appendChild(submit);
  form.appendChild(actions);

  card.appendChild(form);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  translateAll(backdrop, messages);
  wireChangePasswordForm(form, messages);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeChangePasswordModal();
  });
  close.addEventListener('click', () => closeChangePasswordModal());
  refreshIcons();
}

function buildPreferenceChoice(name, value, labelKey, checked) {
  const label = el('label', 'preference-choice');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  input.checked = checked;
  label.appendChild(input);
  const text = el('span');
  text.setAttribute('data-i18n', labelKey);
  text.textContent = translate(shellI18n.messages, labelKey);
  label.appendChild(text);
  return label;
}

function buildPreferenceGroup(name, labelKey, choices, selected) {
  const field = el('fieldset', 'field preference-field');
  const legend = el('legend', 'field-label');
  legend.setAttribute('data-i18n', labelKey);
  legend.textContent = translate(shellI18n.messages, labelKey);
  field.appendChild(legend);
  const options = el('div', 'preference-options');
  for (const choice of choices) {
    options.appendChild(buildPreferenceChoice(name, choice.value, choice.labelKey, choice.value === selected));
  }
  field.appendChild(options);
  return field;
}

function syncPreferencesFields(form) {
  for (const [name, value] of Object.entries(userPreferences)) {
    const input = form.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }
}

export function openPreferencesModal(messages = shellI18n.messages) {
  closeUserMenu();
  const existing = document.getElementById('preferencesModal');
  if (existing) {
    existing.classList.remove('hidden');
    syncPreferencesFields(document.getElementById('preferencesForm'));
    translateAll(existing, messages);
    refreshIcons();
    return;
  }

  const backdrop = el('div', 'modal-backdrop password-modal-backdrop preferences-modal-backdrop');
  backdrop.id = 'preferencesModal';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  const card = el('div', 'modal-card password-modal-card preferences-modal-card');
  card.setAttribute('role', 'document');
  const header = el('div', 'modal-header');
  const title = el('h2');
  title.setAttribute('data-i18n', 'preferences.title');
  title.textContent = translate(messages, 'preferences.title');
  const close = el('button', 'modal-close');
  close.type = 'button';
  close.id = 'closePreferencesBtn';
  close.setAttribute('data-i18n-aria-label', 'preferences.title');
  close.setAttribute('aria-label', translate(messages, 'preferences.title'));
  close.appendChild(icon('x'));
  header.appendChild(title);
  header.appendChild(close);
  card.appendChild(header);

  const form = el('form', 'password-form preferences-form');
  form.id = 'preferencesForm';
  form.appendChild(buildPreferenceGroup('first_day_of_week', 'preferences.firstDayLabel', [
    { value: 'Monday', labelKey: 'preferences.firstDay.monday' },
    { value: 'Sunday', labelKey: 'preferences.firstDay.sunday' },
  ], userPreferences.first_day_of_week));
  form.appendChild(buildPreferenceGroup('distance_unit', 'preferences.distanceLabel', [
    { value: 'km', labelKey: 'preferences.distance.km' },
    { value: 'mi', labelKey: 'preferences.distance.mi' },
  ], userPreferences.distance_unit));
  form.appendChild(buildPreferenceGroup('temperature_unit', 'preferences.temperatureLabel', [
    { value: 'C', labelKey: 'preferences.temperature.celsius' },
    { value: 'F', labelKey: 'preferences.temperature.fahrenheit' },
  ], userPreferences.temperature_unit));
  const actions = el('div', 'form-actions');
  const submit = el('button', 'btn-primary');
  submit.type = 'submit';
  submit.id = 'preferencesSubmit';
  submit.appendChild(icon('settings'));
  const submitLabel = el('span');
  submitLabel.setAttribute('data-i18n', 'preferences.save');
  submitLabel.textContent = translate(messages, 'preferences.save');
  submit.appendChild(submitLabel);
  actions.appendChild(submit);
  form.appendChild(actions);
  card.appendChild(form);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  translateAll(backdrop, messages);
  wirePreferencesForm(form, messages);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closePreferencesModal();
  });
  close.addEventListener('click', closePreferencesModal);
  refreshIcons();
}

export function closePreferencesModal() {
  const modal = document.getElementById('preferencesModal');
  if (modal) modal.classList.add('hidden');
}

export function wirePreferencesForm(form, messages = shellI18n.messages) {
  const submit = form.querySelector('#preferencesSubmit');
  const submitLabel = submit.querySelector('span');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const activeMessages = shellI18n.messages;
    const values = {
      first_day_of_week: form.elements.first_day_of_week.value,
      distance_unit: form.elements.distance_unit.value,
      temperature_unit: form.elements.temperature_unit.value,
    };
    submit.disabled = true;
    submitLabel.textContent = translate(activeMessages, 'preferences.saving');
    try {
      const saved = await updateUserPreferences(values);
      userPreferences = writeUserPreferences(saved);
      document.dispatchEvent(new CustomEvent('kinesis:preferences-changed', {
        detail: { ...userPreferences },
      }));
      showShellToast(activeMessages, 'preferences.saved');
      closePreferencesModal();
    } catch {
      showShellToast(activeMessages, 'preferences.error', 'error');
    } finally {
      submit.disabled = false;
      submitLabel.textContent = translate(activeMessages, 'preferences.save');
    }
  });
}

export function closeChangePasswordModal() {
  const modal = document.getElementById('changePasswordModal');
  if (!modal) return;
  const form = document.getElementById('changePasswordForm');
  if (form) form.reset();
  const formError = document.getElementById('changePasswordFormError');
  if (formError) {
    clearPasswordFormError(formError);
  }
  document.querySelectorAll('.password-form .input-error').forEach((node) => {
    node.classList.remove('input-error');
  });
  const submit = document.getElementById('changePasswordSubmit');
  if (submit) {
    submit.disabled = false;
    const label = submit.querySelector('span');
    if (label) label.textContent = translate(shellI18n.messages, 'password.submit');
  }
  modal.classList.add('hidden');
}

function clearPasswordFormError(formError) {
  const list = formError.querySelector('ul');
  if (list) list.textContent = '';
  formError.classList.add('hidden');
}

// Renders the grouped error list using a specific messages dictionary. The
// translation lookups happen strictly here, at render time, so the strings
// always reflect the dictionary passed in (never a stale module-scope copy).
function renderPasswordFormErrors(formError, messages, errorCodes, params) {
  const list = formError.querySelector('ul');
  if (list) {
    list.textContent = '';
    for (const code of errorCodes) {
      const item = document.createElement('li');
      item.dataset.code = code;
      item.textContent = translate(messages, `auth.errors.${code}`, params);
      list.appendChild(item);
    }
  }
  formError.classList.remove('hidden');
}

// Re-renders any visible change-password errors in the currently active
// language. Invoked on language switch so the grouped alert box (the only
// place errors are shown) updates in sync with the rest of the UI.
export function reapplyPasswordErrors(messages = shellI18n.messages) {
  const formError = document.getElementById('changePasswordFormError');
  if (!formError || formError.classList.contains('hidden')) return;
  const list = formError.querySelector('ul');
  if (!list) return;
  const current = list.textContent;
  const codes = [];
  for (const item of list.querySelectorAll('li')) {
    codes.push(item.dataset.code);
  }
  if (codes.length === 0) return;
  list.textContent = '';
  for (const code of codes) {
    const item = document.createElement('li');
    item.dataset.code = code;
    item.textContent = translate(messages, `auth.errors.${code}`, { min: MIN_PASSWORD_LENGTH });
    list.appendChild(item);
  }
  if (list.textContent !== current) {
    formError.classList.remove('hidden');
  }
}

export function wireChangePasswordForm(form, messages = shellI18n.messages) {
  const submit = form.querySelector('#changePasswordSubmit');
  const submitLabel = submit.querySelector('span');
  const formError = form.querySelector('#changePasswordFormError');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearPasswordFormError(formError);

    // Resolve the dictionary at submit time so the strings always reflect
    // the currently active language, never a stale module-scope snapshot.
    const activeMessages = shellI18n.messages;

    const values = {
      currentPassword: form.elements.currentPassword.value,
      newPassword: form.elements.newPassword.value,
      confirmNewPassword: form.elements.confirmNewPassword.value,
    };

    const validation = validatePasswordChange(values);
    document.querySelectorAll('.password-form .input-error').forEach((node) => {
      node.classList.remove('input-error');
    });
    if (!validation.valid) {
      if (validation.invalid.current) {
        form.elements.currentPassword.classList.add('input-error');
      }
      if (validation.invalid.next) {
        form.elements.newPassword.classList.add('input-error');
      }
      if (validation.invalid.confirm) {
        form.elements.confirmNewPassword.classList.add('input-error');
      }
      renderPasswordFormErrors(formError, activeMessages, validation.errors, {
        min: MIN_PASSWORD_LENGTH,
      });
      return;
    }

    submit.disabled = true;
    submitLabel.textContent = translate(activeMessages, 'password.submitting');
    refreshIcons();
    try {
      await changePassword(values);
      showShellToast(activeMessages, 'password.toastSuccess');
      closeChangePasswordModal();
    } catch (error) {
      const codes = error.codes && error.codes.length > 0 ? error.codes : ['save'];
      renderPasswordFormErrors(formError, activeMessages, codes, {
        min: MIN_PASSWORD_LENGTH,
      });
      submit.disabled = false;
      submitLabel.textContent = translate(activeMessages, 'password.submit');
    }
  });
}

export function toggleUserMenu() {
  const dropdown = document.getElementById('userDropdown');
  const trigger = document.getElementById('userBadge');
  const isOpen = dropdown && !dropdown.classList.contains('hidden');
  const expand = !isOpen;
  if (dropdown) dropdown.classList.toggle('hidden', !expand);
  if (trigger) {
    trigger.classList.toggle('open', expand);
    trigger.setAttribute('aria-expanded', String(expand));
  }
  refreshIcons();
}

function openUserMenu() {
  const dropdown = document.getElementById('userDropdown');
  const trigger = document.getElementById('userBadge');
  if (dropdown) dropdown.classList.remove('hidden');
  if (trigger) {
    trigger.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
  }
  refreshIcons();
}

export function closeUserMenu() {
  const dropdown = document.getElementById('userDropdown');
  const trigger = document.getElementById('userBadge');
  if (dropdown) dropdown.classList.add('hidden');
  if (trigger) {
    trigger.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  }
}

export function wireUserMenu() {
  const trigger = document.getElementById('userBadge');
  const dropdown = document.getElementById('userDropdown');

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleUserMenu();
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('.user-menu')) return;
    closeUserMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeUserMenu();
      closeChangePasswordModal();
      closePreferencesModal();
    }
  });

  // The menu item is a real feature trigger: it opens the Change Password
  // modal instead of merely collapsing the dropdown.
  document.getElementById('userChangePassword').addEventListener('click', () => {
    openChangePasswordModal();
  });
  document.getElementById('userPreferences').addEventListener('click', () => {
    openPreferencesModal();
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

  userPreferences = writeUserPreferences({
    ...readUserPreferences(),
    first_day_of_week: user.first_day_of_week,
    distance_unit: user.distance_unit,
    temperature_unit: user.temperature_unit,
  });

  setUserBadge(user);
  wireLogout();
  // The user menu wires up before any page-specific guard runs, so a guard
  // failure can never leave the account trigger unbound.
  wireUserMenu();

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

  try {
    if (!hasActiveCycle) {
      applyCycleGuard(shellRoot);
    }
  } catch {
    /* the cycle guard must never halt the shell mount */
  }

  window.addEventListener('kinesis:cycle-changed', () => refreshCycleGuard(shellRoot));

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

  // The Change Password modal is shell-owned, so its live validation errors
  // (the grouped alert box) must follow the language switch in real time.
  window.addEventListener('app:languagechange', () => {
    reapplyPasswordErrors();
    const submit = document.getElementById('changePasswordSubmit');
    if (submit && !submit.disabled) {
      const label = submit.querySelector('span');
      if (label) label.textContent = translate(shellI18n.messages, 'password.submit');
    }
    const preferencesModal = document.getElementById('preferencesModal');
    if (preferencesModal && !preferencesModal.classList.contains('hidden')) {
      translateAll(preferencesModal, shellI18n.messages);
      syncPreferencesFields(document.getElementById('preferencesForm'));
    }
  });

  document.body.classList.remove('shell-loading');
  document.body.classList.add('shell-mounted');
  return user;
}

export function applyCycleGuard(shellRoot) {
  const badges = shellRoot.querySelectorAll('.cycle-guard-badge');
  for (const navEntry of shellRoot.querySelectorAll('.nav-item')) {
    if (CYCLE_DEPENDENT_ITEMS.includes(navEntry.dataset.navId)) {
      navEntry.classList.add('disabled');
      navEntry.setAttribute('aria-disabled', 'true');
      navEntry.removeAttribute('href');
      navEntry.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = CYCLE_REDIRECT_TO;
      });
    }
  }
  for (const badge of badges) {
    badge.classList.remove('hidden');
  }
  refreshIcons();
}

function removeCycleGuard(shellRoot) {
  for (const navEntry of shellRoot.querySelectorAll('.nav-item')) {
    if (CYCLE_DEPENDENT_ITEMS.includes(navEntry.dataset.navId)) {
      const item = NAV_ITEMS.find((n) => n.id === navEntry.dataset.navId);
      navEntry.classList.remove('disabled');
      navEntry.removeAttribute('aria-disabled');
      if (item) navEntry.href = item.href;
    }
  }
  for (const badge of shellRoot.querySelectorAll('.cycle-guard-badge')) {
    badge.classList.add('hidden');
  }
  refreshIcons();
}

async function refreshCycleGuard(shellRoot) {
  try {
    const resp = await fetch('/api/cycles/active', { headers: { accept: 'application/json' } });
    if (resp.ok) {
      const data = await resp.json();
      if (data.cycle) {
        removeCycleGuard(shellRoot);
      } else {
        applyCycleGuard(shellRoot);
      }
    }
  } catch {
    /* network hiccup — keep current sidebar state */
  }
}
