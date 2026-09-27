import {
  getUserDisplayName,
  getShellI18n,
  initShell,
  refreshIcons,
  showConfirm,
  updateUserBadgeIdentity,
} from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { createDialogFocusTrap } from './shared/dialog-focus.js';
import { isValidEmail, MIN_PASSWORD_LENGTH } from './shared/validators.js';
import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminUser,
  fetchAdminUsers,
  setAdminUserActivity,
  updateAdminUser,
} from './shared/api.js';

const ROLE_ADMIN = 'admin';
const ROLE_USER = 'user';
const ACTION_ACTIVATE = 'activate';
const ACTION_DEACTIVATE = 'deactivate';
const PASSWORD_CONFIRMATION_ERRORS = [
  'admin.errors.passwordConfirmationRequired',
  'admin.errors.passwordMismatch',
];

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
  return getUserDisplayName(account);
}

export function validateAccountForm(
  { firstName, lastName, email, password, passwordConfirm },
  { requirePassword },
) {
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
    // The initial password is typed twice, so a typo cannot be stored as the
    // account's password. The confirmation never leaves the browser: the API
    // contract takes `password` only.
    if (!passwordConfirm) {
      errors.push('admin.errors.passwordConfirmationRequired');
    } else if (password && passwordConfirm !== password) {
      errors.push('admin.errors.passwordMismatch');
    }
  }
  return errors;
}

// Server codes are stable; anything else falls back to a generic localized
// message so internal details are never surfaced.
const ERROR_KEYS = {
  emailInUse: 'admin.errors.emailInUse',
  accountNotFound: 'admin.errors.accountNotFound',
  lastAdministrator: 'admin.errors.lastAdministrator',
  adminAuthorityRevoked: 'admin.errors.authorityRevoked',
  selfDeleteForbidden: 'admin.errors.selfAction',
  selfActivityForbidden: 'admin.errors.selfAction',
  privilegedTarget: 'admin.errors.privilegedTarget',
  activityConflict: 'admin.errors.activityConflict',
  invalidId: 'admin.errors.accountNotFound',
  invalidRegistration: 'admin.errors.invalidRegistration',
  unknownField: 'admin.errors.invalidRegistration',
  activityFieldForbidden: 'admin.errors.activityState',
  noChanges: 'admin.errors.invalidRegistration',
};

export function errorMessageKey(error) {
  const code = Array.isArray(error?.codes) ? error.codes[0] : null;
  return ERROR_KEYS[code] ?? 'admin.errors.request';
}

export function errorCode(error) {
  return Array.isArray(error?.codes) ? error.codes[0] ?? null : null;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

let lastFocus = null;
let lastFocusTarget = null;
let savePending = false;
let operationPending = false;
let rowActionPending = false;
let pendingRefreshFocus = null;
let editRequestId = 0;
const focusTrap = createDialogFocusTrap(document.getElementById('userModal'), () => closeModal());

function buildTooltipButton({ action, id, icon, labelKey, tooltipKey, messages, danger }) {
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
  tooltip.textContent = t(messages, tooltipKey ?? `${labelKey}Tooltip`);
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
  // The activity state is its own badge: an inactive account is shown as such
  // instead of being inferred from the action offered on the row.
  const isActive = account.is_active !== false;
  const status = el('span', `user-status${isActive ? '' : ' status-inactive'}`);
  status.textContent = t(messages, `admin.status.${isActive ? 'active' : 'inactive'}`);
  badges.appendChild(status);
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
  // Only regular accounts can change state, and never the signed-in one: the
  // backend refuses both, so activating an account here can never hand back
  // administrator access.
  if (!isAdmin && account.id !== currentUserId) {
    actions.appendChild(buildTooltipButton({
      action: isActive ? ACTION_DEACTIVATE : ACTION_ACTIVATE,
      id: account.id,
      icon: isActive ? 'user-x' : 'user-check',
      // The row control names the account it acts on; the dialog keeps the
      // shorter verb for its confirm button.
      labelKey: isActive ? 'admin.deactivateLabel' : 'admin.activateLabel',
      tooltipKey: isActive ? 'admin.deactivateTooltip' : 'admin.activateTooltip',
      messages,
      danger: isActive,
    }));
  }
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
  document.getElementById('addUserBtn').disabled = loading || savePending || operationPending || rowActionPending;
}

function findUserActionButton(target) {
  if (!target?.id || !target.action) return null;
  return [...document.querySelectorAll(`[data-action="${target.action}"]`)]
    .find((button) => button.dataset.id === String(target.id)) ?? null;
}

function beginRefreshFocus(target) {
  pendingRefreshFocus = {
    target,
    initialActive: document.activeElement,
    userMoved: false,
  };
}

function noteRefreshFocusMove(event) {
  if (!pendingRefreshFocus || !event.target?.isConnected) return;
  // The confirmation dialog moves focus while it is open and hands it back on
  // close. That is its own lifecycle, not the user leaving the control being
  // tracked, so it must not cancel the restoration that follows the rerender.
  if (event.target.closest?.('.confirm-backdrop')) return;
  if (event.target !== pendingRefreshFocus.initialActive && event.target !== document.body) {
    pendingRefreshFocus.userMoved = true;
  }
}

function restoreRefreshFocus() {
  const pending = pendingRefreshFocus;
  pendingRefreshFocus = null;
  if (!pending || pending.userMoved) return;
  const trigger = findUserActionButton(pending.target);
  const fallback = document.getElementById('addUserBtn');
  (trigger?.isConnected && !trigger.disabled ? trigger : fallback)?.focus();
}

function renderList(accounts, context) {
  const list = document.getElementById('userList');
  list.textContent = '';
  setState({
    error: context.listErrorVisible,
    empty: !context.listErrorVisible && accounts.length === 0,
  });
  for (const account of accounts) {
    list.appendChild(renderUserRow(account, context));
  }
  setListActionsDisabled(rowActionPending || savePending || operationPending);
  refreshIcons();
}

function setListActionsDisabled(disabled) {
  document.querySelectorAll('#userList [data-action]').forEach((button) => {
    button.disabled = disabled;
  });
  document.getElementById('userList').setAttribute('aria-busy', String(disabled));
}

// The visible error is held as translation keys rather than rendered text, so a
// PT ↔ EN switch can restate the same explanation in the new language instead
// of dropping the message the user still has to act on. Local validation
// contributes keys, and an API failure contributes the key mapped from the
// server's stable code, so the raw server prose is never shown.
let formErrorKeys = [];

function showFormError(messages, errorKeys) {
  formErrorKeys = errorKeys;
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
  formErrorKeys = [];
  const box = document.getElementById('userFormError');
  box.textContent = '';
  box.classList.add('hidden');
}

// Restates a still-visible error in the current language. Everything the user
// typed, the create/edit mode, the focused control and the dialog state are
// left untouched.
function refreshFormError(messages) {
  if (formErrorKeys.length === 0) return;
  showFormError(messages, formErrorKeys);
}

function openModal(mode, account, context) {
  if (savePending) return;
  const { messages } = context;
  const isEdit = mode === 'edit';
  const title = document.getElementById('userModalTitle');
  const titleKey = isEdit ? 'admin.formTitleEdit' : 'admin.formTitleAdd';
  title.setAttribute('data-i18n', titleKey);
  title.textContent = t(messages, titleKey);

  document.getElementById('userFirstName').value = account?.first_name ?? '';
  document.getElementById('userLastName').value = account?.last_name ?? '';
  document.getElementById('userEmail').value = account?.email ?? '';
  // The initial password and its confirmation are requested at creation only
  // and are never stored or shown again afterwards.
  document.getElementById('userPasswordFields').classList.toggle('hidden', isEdit);
  document.getElementById('userPassword').value = '';
  resetPasswordConfirmation();

  const submitLabel = document.getElementById('userFormSubmitLabel');
  submitLabel.setAttribute('data-i18n', 'admin.save');
  submitLabel.textContent = t(messages, 'admin.save');

  const form = document.getElementById('userForm');
  form.dataset.mode = mode;
  form.dataset.userId = account ? String(account.id) : '';
  form.dataset.initialFirstName = isEdit ? String(account.first_name ?? '').trim() : '';
  form.dataset.initialLastName = isEdit ? String(account.last_name ?? '').trim() : '';
  form.dataset.initialEmail = isEdit ? String(account.email ?? '').trim().toLowerCase() : '';
  hideFormError();
  lastFocus = document.activeElement;
  lastFocusTarget = lastFocus?.dataset?.action && lastFocus?.dataset?.id
    ? { action: lastFocus.dataset.action, id: lastFocus.dataset.id }
    : null;
  document.getElementById('userModal').classList.remove('hidden');
  focusTrap.activate();
  document.getElementById('userFirstName').focus();
}

function closeModal() {
  const modal = document.getElementById('userModal');
  if (savePending) return false;
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  focusTrap.deactivate();
  const trigger = lastFocus?.isConnected ? lastFocus : findUserActionButton(lastFocusTarget);
  const fallback = document.getElementById('addUserBtn');
  (trigger ?? fallback)?.focus();
  lastFocus = null;
  lastFocusTarget = null;
  return true;
}

function setSavePending(pending, messages) {
  savePending = pending;
  const modal = document.getElementById('userModal');
  const form = document.getElementById('userForm');
  const submitBtn = document.getElementById('userFormSubmit');
  const submitLabel = document.getElementById('userFormSubmitLabel');
  const cancelBtn = document.getElementById('userFormCancel');
  const closeBtn = document.getElementById('userModalClose');
  modal.setAttribute('aria-busy', String(pending));
  form.setAttribute('aria-busy', String(pending));
  submitBtn.disabled = pending;
  cancelBtn.disabled = pending;
  closeBtn.disabled = pending;
  document.getElementById('addUserBtn').disabled = pending || operationPending || rowActionPending;
  setListActionsDisabled(pending || operationPending || rowActionPending);
  submitLabel.textContent = t(messages, pending ? 'admin.saving' : 'admin.save');
}

function setRowActionPending(pending) {
  rowActionPending = pending;
  document.getElementById('userList').setAttribute('aria-busy', String(pending));
  setListActionsDisabled(pending || savePending || operationPending);
  document.getElementById('addUserBtn').disabled = pending || savePending || operationPending;
}

// The confirmation field is associated with the grouped error box — the only
// error surface on this dialog — so the mismatch is announced, described and
// visibly marked without adding a second, page-specific hint. Typing in the
// field clears the association but keeps everything the user already typed.
function resetPasswordConfirmation() {
  const field = document.getElementById('userPasswordConfirm');
  field.value = '';
  field.classList.remove('input-error');
  field.removeAttribute('aria-invalid');
  field.removeAttribute('aria-describedby');
}

function markPasswordConfirmation(errors) {
  const field = document.getElementById('userPasswordConfirm');
  if (!errors.some((key) => PASSWORD_CONFIRMATION_ERRORS.includes(key))) return;
  field.classList.add('input-error');
  field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-describedby', 'userFormError');
  field.focus();
}

function readForm() {
  return {
    firstName: document.getElementById('userFirstName').value,
    lastName: document.getElementById('userLastName').value,
    email: document.getElementById('userEmail').value,
    password: document.getElementById('userPassword').value,
    passwordConfirm: document.getElementById('userPasswordConfirm').value,
  };
}

async function reload(context) {
  const accounts = await fetchAdminUsers();
  context.accounts = accounts;
  context.listErrorVisible = false;
  renderList(accounts, context);
}

function showListError(context, messageKey = 'admin.loadError') {
  context.listErrorKey = messageKey;
  context.listErrorVisible = true;
  context.accounts = [];
  document.getElementById('userList').textContent = '';
  const error = document.getElementById('usersError');
  const message = error.querySelector('p');
  message.setAttribute('data-i18n', messageKey);
  message.textContent = t(context.messages, messageKey);
  setState({ error: true });
}

async function handleSubmit(context) {
  if (savePending || operationPending) return;
  const { messages } = context;
  const form = document.getElementById('userForm');
  const isEdit = form.dataset.mode === 'edit';
  const fields = readForm();
  const errors = validateAccountForm(fields, { requirePassword: !isEdit });
  if (errors.length > 0) {
    // The typed values stay in the dialog so the administrator can correct the
    // confirmation instead of retyping the whole account.
    showFormError(messages, errors);
    markPasswordConfirmation(errors);
    return;
  }

  const submitBtn = document.getElementById('userFormSubmit');
  const submitLabel = document.getElementById('userFormSubmitLabel');
  operationPending = true;
  setSavePending(true, messages);

  try {
    if (isEdit) {
      const normalized = {
        first_name: fields.firstName.trim(),
        last_name: fields.lastName.trim(),
        email: fields.email.trim().toLowerCase(),
      };
      const payload = {
        ...(normalized.first_name !== form.dataset.initialFirstName
          ? { first_name: normalized.first_name } : {}),
        ...(normalized.last_name !== form.dataset.initialLastName
          ? { last_name: normalized.last_name } : {}),
        ...(normalized.email !== form.dataset.initialEmail
          ? { email: normalized.email } : {}),
      };
      if (Object.keys(payload).length === 0) {
        showFormError(context.messages, ['admin.errors.noChanges']);
        return;
      }
      const updatedUser = await updateAdminUser(form.dataset.userId, payload);
      if (String(form.dataset.userId) === String(context.currentUserId)) {
        updateUserBadgeIdentity(updatedUser);
      }
    } else {
      await createAdminUser({
        first_name: fields.firstName.trim(),
        last_name: fields.lastName.trim(),
        email: fields.email.trim().toLowerCase(),
        password: fields.password,
      });
    }
    // The mutation succeeded, so close the dialog and show success now. Keep
    // the page operation serialized until its list refresh also settles.
    setSavePending(false, context.messages);
    closeModal();
    // closeModal() restores focus to the old trigger. Start tracking only
    // after that expected programmatic transition, so it is not mistaken for
    // an intentional user move while the replacement list is loading.
    beginRefreshFocus(isEdit
      ? { action: 'edit', id: form.dataset.userId }
      : null);
    showToast(context.messages, isEdit ? 'admin.success.edit' : 'admin.success.create');
    try {
      await reload(context);
    } catch {
      showListError(context, 'admin.refreshError');
    }
  } catch (error) {
    setSavePending(false, context.messages);
    showFormError(context.messages, [errorMessageKey(error)]);
  } finally {
    operationPending = false;
    setSavePending(false, context.messages);
    restoreRefreshFocus();
    submitBtn.disabled = false;
    submitLabel.textContent = t(context.messages, 'admin.save');
  }
}

async function handleAction(action, id, context) {
  if (savePending || rowActionPending) return;
  const { messages } = context;
  // Deleting and changing the activity state both supersede a pending edit
  // lookup, so a dialog can never open for a row that is being changed.
  if (action === 'delete' || action === ACTION_ACTIVATE || action === ACTION_DEACTIVATE) {
    editRequestId += 1;
  }
  if (action === 'edit') {
    const requestId = ++editRequestId;
    // Re-read the account from the server so the form never trusts a stale row.
    try {
      const account = await fetchAdminUser(id);
      if (requestId !== editRequestId) return;
      openModal('edit', account, context);
    } catch (error) {
      if (requestId !== editRequestId) return;
      showToast(context.messages, errorMessageKey(error), 'error');
    }
    return;
  }

  if (action === ACTION_ACTIVATE || action === ACTION_DEACTIVATE) {
    await handleActivity(action, id, context);
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

  beginRefreshFocus({ action: 'delete', id });
  setRowActionPending(true);
  try {
    await deleteAdminUser(id);
    showToast(context.messages, 'admin.success.delete');
    try {
      await reload(context);
    } catch {
      showListError(context, 'admin.refreshError');
    }
  } catch (error) {
    showToast(context.messages, errorMessageKey(error), 'error');
  } finally {
    setRowActionPending(false);
    restoreRefreshFocus();
    const active = document.activeElement;
    if (!active?.isConnected || active.disabled) {
      (document.querySelector('#userList [data-action]')
        ?? document.getElementById('addUserBtn'))?.focus();
    }
  }
}

async function handleActivity(action, id, context) {
  const { messages } = context;
  const account = context.accounts.find((entry) => String(entry.id) === String(id));
  if (!account) return;
  const expectedActive = account.is_active !== false;
  const nextActive = action === ACTION_ACTIVATE;
  // The dialog names the account and states the exact effect: deactivating ends
  // its access and its sessions right away while keeping every record, and
  // reactivating restores the login without restoring revoked sessions.
  const confirmed = await showConfirm({
    title: t(messages, nextActive ? 'admin.activateTitle' : 'admin.deactivateTitle'),
    message: t(messages, nextActive ? 'admin.activateConfirm' : 'admin.deactivateConfirm', {
      email: account.email,
    }),
    icon: nextActive ? 'user-check' : 'user-x',
    confirmLabel: t(messages, nextActive ? 'admin.activate' : 'admin.deactivate'),
    cancelLabel: t(messages, 'admin.cancel'),
    confirmButtonClass: nextActive ? 'btn-primary' : 'btn-danger',
  });
  if (!confirmed) return;

  // A refused transition leaves the clicked control in place; a successful one
  // offers the opposite action, so focus is re-tracked onto it below.
  beginRefreshFocus({ action, id });
  setRowActionPending(true);
  try {
    await setAdminUserActivity(id, { active: nextActive, expectedActive });
    showToast(context.messages, nextActive ? 'admin.success.activate' : 'admin.success.deactivate');
    try {
      await reload(context);
    } catch {
      showListError(context, 'admin.refreshError');
    }
    beginRefreshFocus({ action: nextActive ? ACTION_DEACTIVATE : ACTION_ACTIVATE, id });
  } catch (error) {
    showToast(context.messages, errorMessageKey(error), 'error');
    // A refused transition means this list no longer shows the real state, so
    // the list is refreshed instead of leaving a stale row to be clicked again.
    if (errorCode(error) === 'activityConflict') {
      try {
        await reload(context);
      } catch {
        showListError(context, 'admin.refreshError');
      }
    }
  } finally {
    setRowActionPending(false);
    restoreRefreshFocus();
    const active = document.activeElement;
    if (!active?.isConnected || active.disabled) {
      (document.querySelector('#userList [data-action]')
        ?? document.getElementById('addUserBtn'))?.focus();
    }
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
    listErrorKey: 'admin.loadError',
    listErrorVisible: false,
  };

  const sync = () => {
    context.messages = i18n.messages;
    context.language = i18n.language;
  };

  document.getElementById('addUserBtn').addEventListener('click', () => {
    if (savePending || operationPending || rowActionPending) return;
    editRequestId += 1;
    openModal('add', null, context);
  });
  document.addEventListener('focusin', noteRefreshFocusMove);
  document.getElementById('userModalClose').addEventListener('click', closeModal);
  document.getElementById('userFormCancel').addEventListener('click', closeModal);
  document.getElementById('userModal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });
  document.getElementById('userForm').addEventListener('submit', (event) => {
    event.preventDefault();
    handleSubmit(context);
  });
  // Correcting the confirmation clears the field's association with the error
  // box; the box itself stays until the next submit, exactly like the other
  // grouped validation errors.
  document.getElementById('userPasswordConfirm').addEventListener('input', (event) => {
    event.target.classList.remove('input-error');
    event.target.removeAttribute('aria-invalid');
  });
  document.getElementById('userList').addEventListener('click', (event) => {
    if (savePending || operationPending) return;
    const button = event.target.closest('[data-action]');
    if (!button) return;
    handleAction(button.dataset.action, button.dataset.id, context);
  });
  document.getElementById('retryUsersBtn').addEventListener('click', () => {
    load(context, context.listErrorKey);
  });

  async function load(target, errorKey = 'admin.loadError') {
    setState({ loading: true });
    try {
      await reload(target);
    } catch {
      showListError(target, errorKey);
    }
  }

  document.addEventListener('app:languagechange', () => {
    sync();
    renderList(context.accounts, context);
    if (!document.getElementById('usersError').classList.contains('hidden')) {
      const message = document.querySelector('#usersError p');
      message.setAttribute('data-i18n', context.listErrorKey);
      message.textContent = t(context.messages, context.listErrorKey);
    }
    const modal = document.getElementById('userModal');
    if (!modal.classList.contains('hidden')) {
      // The title's `data-i18n` still points at the create or edit key chosen
      // when the dialog opened, so the mode survives the switch.
      const titleEl = document.getElementById('userModalTitle');
      titleEl.textContent = t(context.messages, titleEl.getAttribute('data-i18n'));
      document.getElementById('userFormSubmitLabel').textContent = t(
        context.messages,
        savePending ? 'admin.saving' : 'admin.save',
      );
      // Restate a pending error in the new language instead of clearing it.
      refreshFormError(context.messages);
    }
  });

  document.addEventListener('kinesis:preferences-changed', sync);

  await load(context);
  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initAdminPage().catch(() => window.location.replace('/login.html'));
}
