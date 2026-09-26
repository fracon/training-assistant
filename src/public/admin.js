import { initShell, getShellI18n, refreshIcons, showConfirm } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { createDialogFocusTrap } from './shared/dialog-focus.js';
import { isValidEmail, MIN_PASSWORD_LENGTH } from './shared/validators.js';
import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminUser,
  fetchAdminUsers,
  updateAdminUser,
} from './shared/api.js';

const ROLE_ADMIN = 'admin';
const ROLE_USER = 'user';

function t(messages, key, params) {
  return translate(messages, key, params);
}

function showToast(messages, messageKey, type = 'success', params) {
  const toast = document.getElementById('toast');
  const textEl = toast.querySelector('.toast-text');
  const iconEl = toast.querySelector('.toast-icon');
  if (iconEl) {
    iconEl.innerHTML = `<i data-lucide="${type === 'error' ? 'x-circle' : 'check-circle'}"></i>`;
  }
  textEl.textContent = t(messages, messageKey, params);
  toast.classList.toggle('toast-error', type === 'error');
  toast.classList.add('visible');
  refreshIcons();
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

export function accountName(account) {
  const name = [account?.first_name, account?.last_name]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .trim();
  return name || account?.email || '';
}

export function validateAccountForm({ firstName, lastName, email, password, role }, { requirePassword }) {
  const errors = [];
  if (!firstName.trim()) errors.push('admin.errors.firstNameRequired');
  if (!lastName.trim()) errors.push('admin.errors.lastNameRequired');
  if (!email.trim()) {
    errors.push('admin.errors.emailRequired');
  } else if (!isValidEmail(email)) {
    errors.push('admin.errors.emailInvalid');
  }
  if (requirePassword) {
    if (!password) {
      errors.push('admin.errors.passwordRequired');
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      errors.push('admin.errors.passwordMin');
    }
  }
  if (role !== ROLE_ADMIN && role !== ROLE_USER) {
    errors.push('admin.errors.roleInvalid');
  }
  return errors;
}

// Server codes are stable; anything else falls back to a generic localized
// message so internal details are never surfaced.
const ERROR_KEYS = {
  emailInUse: 'admin.errors.emailInUse',
  accountNotFound: 'admin.errors.accountNotFound',
  lastAdministrator: 'admin.errors.lastAdministrator',
  selfDeleteForbidden: 'admin.errors.selfAction',
  selfRoleChangeForbidden: 'admin.errors.selfAction',
  invalidRole: 'admin.errors.roleInvalid',
  invalidId: 'admin.errors.accountNotFound',
  invalidRegistration: 'admin.errors.invalidRegistration',
  unknownField: 'admin.errors.invalidRegistration',
  noChanges: 'admin.errors.invalidRegistration',
};

export function errorMessageKey(error) {
  const code = Array.isArray(error?.codes) ? error.codes[0] : null;
  return ERROR_KEYS[code] ?? 'admin.errors.request';
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

let lastFocus = null;
const focusTrap = createDialogFocusTrap(document.getElementById('userModal'), () => closeModal());

function buildTooltipButton({ action, id, icon, labelKey, messages, danger }) {
  const button = el('button', `btn-icon${danger ? ' btn-danger' : ''}`);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = String(id);
  const label = t(messages, labelKey);
  button.setAttribute('aria-label', label);
  const iconEl = el('i');
  iconEl.setAttribute('data-lucide', icon);
  button.appendChild(iconEl);
  // The Kinesis custom tooltip replaces the native title attribute.
  const tooltip = el('div', 'custom-tooltip');
  tooltip.textContent = t(messages, `${labelKey}Tooltip`);
  button.appendChild(tooltip);
  return button;
}

function renderUserRow(account, { messages, currentUserId, language }) {
  const row = el('li', 'user-row');
  row.dataset.userId = String(account.id);

  const main = el('div', 'user-row-main');
  const identity = el('div', 'user-identity');
  const name = el('span', 'user-name');
  // Account fields are untrusted input: inserted as text, never as markup.
  name.textContent = accountName(account);
  identity.appendChild(name);
  const email = el('span', 'user-email');
  email.textContent = account.email;
  identity.appendChild(email);
  main.appendChild(identity);

  const badges = el('div', 'user-badges');
  const isAdmin = account.role === ROLE_ADMIN;
  const role = el('span', `user-role${isAdmin ? ' role-admin' : ''}`);
  role.textContent = t(messages, `admin.roles.${isAdmin ? ROLE_ADMIN : ROLE_USER}`);
  badges.appendChild(role);
  if (account.id === currentUserId) {
    const self = el('span', 'user-self-chip');
    self.textContent = t(messages, 'admin.you');
    badges.appendChild(self);
  }
  main.appendChild(badges);
  row.appendChild(main);

  const meta = el('div', 'user-row-meta');
  const created = el('span', 'user-created');
  // SQLite stores `created_at` as `YYYY-MM-DD HH:MM:SS`; the shared formatter
  // accepts a date only, so the time part is dropped before formatting.
  const createdDate = account.created_at
    ? formatDate(String(account.created_at).slice(0, 10), language)
    : '';
  created.textContent = createdDate
    ? t(messages, 'admin.createdAt', { date: createdDate })
    : '';
  meta.appendChild(created);
  const actions = el('div', 'user-row-actions');
  actions.appendChild(buildTooltipButton({
    action: 'edit', id: account.id, icon: 'pencil', labelKey: 'admin.edit', messages,
  }));
  // The panel never offers to delete the signed-in account; the backend refuses
  // it as well so the protection does not depend on the interface.
  if (account.id !== currentUserId) {
    actions.appendChild(buildTooltipButton({
      action: 'delete', id: account.id, icon: 'trash-2', labelKey: 'admin.delete', messages, danger: true,
    }));
  }
  meta.appendChild(actions);
  row.appendChild(meta);
  return row;
}

function setState({ loading = false, error = false, empty = false }) {
  document.getElementById('usersLoading').classList.toggle('hidden', !loading);
  document.getElementById('usersError').classList.toggle('hidden', !error);
  document.getElementById('usersEmpty').classList.toggle('hidden', !empty);
  document.getElementById('addUserBtn').disabled = loading;
}

function renderList(accounts, context) {
  const list = document.getElementById('userList');
  list.textContent = '';
  setState({ empty: accounts.length === 0 });
  for (const account of accounts) {
    list.appendChild(renderUserRow(account, context));
  }
  refreshIcons();
}

function showFormError(messages, errorKeys) {
  const box = document.getElementById('userFormError');
  box.textContent = '';
  if (errorKeys.length === 1) {
    box.textContent = t(messages, errorKeys[0]);
  } else if (errorKeys.length > 1) {
    const list = document.createElement('ul');
    for (const key of errorKeys) {
      const item = document.createElement('li');
      item.textContent = t(messages, key);
      list.appendChild(item);
    }
    box.appendChild(list);
  }
  box.classList.remove('hidden');
}

function hideFormError() {
  const box = document.getElementById('userFormError');
  box.textContent = '';
  box.classList.add('hidden');
}

function openModal(mode, account, context) {
  const { messages, currentUserId } = context;
  const isEdit = mode === 'edit';
  const title = document.getElementById('userModalTitle');
  const titleKey = isEdit ? 'admin.formTitleEdit' : 'admin.formTitleAdd';
  title.setAttribute('data-i18n', titleKey);
  title.textContent = t(messages, titleKey);

  document.getElementById('userFirstName').value = account?.first_name ?? '';
  document.getElementById('userLastName').value = account?.last_name ?? '';
  document.getElementById('userEmail').value = account?.email ?? '';
  // The initial password is requested at creation only and is never stored or
  // shown again afterwards.
  document.getElementById('userPasswordField').classList.toggle('hidden', isEdit);
  document.getElementById('userPassword').value = '';

  const isSelf = Boolean(account) && account.id === currentUserId;
  const roleSelect = document.getElementById('userRole');
  roleSelect.value = account?.role ?? ROLE_USER;
  roleSelect.disabled = isSelf;
  document.getElementById('userRoleHint').classList.toggle('hidden', !isSelf);

  const submitLabel = document.getElementById('userFormSubmitLabel');
  submitLabel.setAttribute('data-i18n', 'admin.save');
  submitLabel.textContent = t(messages, 'admin.save');

  const form = document.getElementById('userForm');
  form.dataset.mode = mode;
  form.dataset.userId = account ? String(account.id) : '';
  hideFormError();
  lastFocus = document.activeElement;
  document.getElementById('userModal').classList.remove('hidden');
  focusTrap.activate();
  document.getElementById('userFirstName').focus();
}

function closeModal() {
  const modal = document.getElementById('userModal');
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  focusTrap.deactivate();
  lastFocus?.focus();
  lastFocus = null;
}

function readForm() {
  return {
    firstName: document.getElementById('userFirstName').value,
    lastName: document.getElementById('userLastName').value,
    email: document.getElementById('userEmail').value,
    password: document.getElementById('userPassword').value,
    role: document.getElementById('userRole').value,
  };
}

async function reload(context) {
  const accounts = await fetchAdminUsers();
  context.accounts = accounts;
  renderList(accounts, context);
}

async function handleSubmit(context) {
  const { messages } = context;
  const form = document.getElementById('userForm');
  const isEdit = form.dataset.mode === 'edit';
  const fields = readForm();
  const errors = validateAccountForm(fields, { requirePassword: !isEdit });
  if (errors.length > 0) {
    showFormError(messages, errors);
    return;
  }

  const submitBtn = document.getElementById('userFormSubmit');
  const submitLabel = document.getElementById('userFormSubmitLabel');
  submitBtn.disabled = true;
  submitLabel.textContent = t(messages, 'admin.saving');

  try {
    if (isEdit) {
      const payload = {
        first_name: fields.firstName.trim(),
        last_name: fields.lastName.trim(),
        email: fields.email.trim().toLowerCase(),
      };
      // The role is only sent when the control is editable for this account.
      if (!document.getElementById('userRole').disabled) payload.role = fields.role;
      await updateAdminUser(form.dataset.userId, payload);
    } else {
      await createAdminUser({
        first_name: fields.firstName.trim(),
        last_name: fields.lastName.trim(),
        email: fields.email.trim().toLowerCase(),
        password: fields.password,
        role: fields.role,
      });
    }
    closeModal();
    await reload(context);
    showToast(messages, isEdit ? 'admin.success.edit' : 'admin.success.create');
  } catch (error) {
    showFormError(messages, [errorMessageKey(error)]);
  } finally {
    submitBtn.disabled = false;
    submitLabel.textContent = t(messages, 'admin.save');
  }
}

async function handleAction(action, id, context) {
  const { messages } = context;
  if (action === 'edit') {
    // Re-read the account from the server so the form never trusts a stale row.
    try {
      const account = await fetchAdminUser(id);
      openModal('edit', account, context);
    } catch (error) {
      showToast(messages, errorMessageKey(error), 'error');
    }
    return;
  }

  if (action !== 'delete') return;
  const account = context.accounts.find((entry) => String(entry.id) === String(id));
  if (!account) return;
  // The dialog names the account and states the real, irreversible effect of
  // deleting it, including the data removed by the schema's cascade.
  const confirmed = await showConfirm({
    title: t(messages, 'admin.deleteTitle'),
    message: t(messages, 'admin.deleteConfirm', { email: account.email }),
    icon: 'trash-2',
    confirmLabel: t(messages, 'admin.delete'),
    cancelLabel: t(messages, 'admin.cancel'),
  });
  if (!confirmed) return;

  try {
    await deleteAdminUser(id);
    await reload(context);
    showToast(messages, 'admin.success.delete');
  } catch (error) {
    showToast(messages, errorMessageKey(error), 'error');
  }
}

export async function initAdminPage() {
  const user = await initShell({ active: 'admin-users' });
  if (!user) return null;

  const i18n = getShellI18n();
  const context = {
    messages: i18n.messages,
    language: i18n.language,
    currentUserId: user.id,
    accounts: [],
  };

  const sync = () => {
    context.messages = i18n.messages;
    context.language = i18n.language;
  };

  document.getElementById('addUserBtn').addEventListener('click', () => {
    openModal('add', null, context);
  });
  document.getElementById('userModalClose').addEventListener('click', closeModal);
  document.getElementById('userFormCancel').addEventListener('click', closeModal);
  document.getElementById('userModal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });
  document.getElementById('userForm').addEventListener('submit', (event) => {
    event.preventDefault();
    handleSubmit(context);
  });
  document.getElementById('userList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    handleAction(button.dataset.action, button.dataset.id, context);
  });
  document.getElementById('retryUsersBtn').addEventListener('click', () => {
    setState({ loading: true });
    load(context);
  });

  async function load(target) {
    setState({ loading: true });
    try {
      await reload(target);
    } catch {
      document.getElementById('userList').textContent = '';
      setState({ error: true });
    }
  }

  document.addEventListener('app:languagechange', () => {
    sync();
    renderList(context.accounts, context);
    const modal = document.getElementById('userModal');
    if (!modal.classList.contains('hidden')) {
      const titleEl = document.getElementById('userModalTitle');
      titleEl.textContent = t(context.messages, titleEl.getAttribute('data-i18n'));
      document.getElementById('userFormSubmitLabel').textContent = t(context.messages, 'admin.save');
      hideFormError();
    }
  });

  document.addEventListener('kinesis:preferences-changed', sync);

  await load(context);
  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initAdminPage().catch(() => window.location.replace('/login.html'));
}
