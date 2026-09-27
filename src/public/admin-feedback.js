import { getShellI18n, initShell, refreshIcons, showConfirm } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { createDialogFocusTrap } from './shared/dialog-focus.js';
import { deleteAdminFeedback, fetchAdminFeedback, updateAdminFeedback } from './shared/api.js';

let context;
let detailTrap;
let selected;
let detailState;

const LOAD_RESULT = Object.freeze({ success: 'success', failed: 'failed', replaced: 'replaced' });

function t(key, params) { return translate(context.i18n.messages, key, params); }
function errorKey(error) { return error?.codes?.[0] === 'feedbackNotFound' ? 'feedbackAdmin.notFound' : 'feedbackAdmin.requestError'; }
function statusLabel(status) { return t(`feedbackAdmin.statuses.${status === 'in_progress' ? 'inProgress' : status}`); }
function typeLabel(type) { return t(`feedbackAdmin.types.${type}`); }
function showToast(key, error = false) { const toast = document.getElementById('toast'); toast.querySelector('.toast-text').textContent = t(key); toast.classList.toggle('toast-error', error); toast.classList.add('visible'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('visible'), 2800); refreshIcons(); }

function renderRows(rows) {
  const list = document.getElementById('feedbackList');
  list.textContent = '';
  for (const item of rows) {
    const row = document.createElement('li'); row.className = 'feedback-row';
    const top = document.createElement('div'); top.className = 'feedback-row-top';
    const status = document.createElement('span'); status.className = 'feedback-status'; status.textContent = statusLabel(item.status);
    const type = document.createElement('strong'); type.textContent = typeLabel(item.type);
    top.append(type, status); row.appendChild(top);
    const summary = document.createElement('p'); summary.className = 'feedback-row-summary'; summary.textContent = item.description; row.appendChild(summary);
    const bottom = document.createElement('div'); bottom.className = 'feedback-row-bottom';
    const meta = document.createElement('span'); meta.className = 'feedback-meta'; meta.textContent = `${item.author_email} · ${item.pathname} · ${formatDate(String(item.created_at).slice(0, 10), context.i18n.language)}`;
    const view = document.createElement('button'); view.type = 'button'; view.className = 'btn-secondary'; view.dataset.id = item.id; view.dataset.i18n = 'feedbackAdmin.view'; view.textContent = t('feedbackAdmin.view'); view.addEventListener('click', () => openDetail(item, view));
    bottom.append(meta, view); row.appendChild(bottom); list.appendChild(row);
  }
  refreshIcons();
}

function setState(state = {}) {
  context.state = { ...context.state, ...state };
  document.getElementById('feedbackAdminLoading').classList.toggle('hidden', !context.state.loading);
  document.getElementById('feedbackAdminError').classList.toggle('hidden', !context.state.error);
  document.getElementById('feedbackAdminEmpty').classList.toggle('hidden', !context.state.empty);
}

async function load(reset = true) {
  if (!reset && context.loading) return LOAD_RESULT.replaced;
  const generation = reset ? context.generation + 1 : context.generation;
  if (reset) {
    context.generation = generation;
    context.page = 1;
    context.rows = [];
    context.total = 0;
    renderRows(context.rows);
  }
  const page = reset ? 1 : context.page + 1;
  const requestId = ++context.requestId;
  context.loading = true;
  setState({ loading: true, error: false, empty: false });
  const more = document.getElementById('feedbackLoadMore');
  more.disabled = true;
  try {
    const payload = await fetchAdminFeedback({ status: document.getElementById('feedbackStatusFilter').value, type: document.getElementById('feedbackTypeFilter').value, page, limit: 25 });
    if (generation !== context.generation || requestId !== context.requestId) return LOAD_RESULT.replaced;
    const incoming = reset ? payload.feedback : [...context.rows, ...payload.feedback];
    context.rows = [...new Map(incoming.map((item) => [item.id, item])).values()];
    context.page = page;
    context.total = payload.total;
    renderRows(context.rows);
    setState({ loading: false, error: false, empty: context.rows.length === 0 });
    more.classList.toggle('hidden', context.rows.length >= context.total);
    return LOAD_RESULT.success;
  } catch (error) {
    if (generation !== context.generation || requestId !== context.requestId) return LOAD_RESULT.replaced;
    setState({ loading: false, error: true, empty: false });
    more.classList.add('hidden');
    return LOAD_RESULT.failed;
  } finally {
    if (generation === context.generation && requestId === context.requestId) {
      context.loading = false;
      more.disabled = false;
    }
  }
}

function restoreFocusAfterRefresh(trigger, focusAtRefresh) {
  const active = document.activeElement;
  if (active === focusAtRefresh || active === document.body || !isVisible(active)) restoreDetailFocus(trigger);
}

function isVisible(element) {
  return Boolean(element?.isConnected && !element.hidden && getComputedStyle(element).display !== 'none');
}

function restoreDetailFocus(trigger) {
  if (!isVisible(trigger)) trigger = document.querySelector('#feedbackList button[data-id]') || document.getElementById('feedbackStatusFilter') || document.getElementById('feedbackTypeFilter');
  trigger?.focus?.();
}

function closeDetail({ expectedState } = {}) {
  if (detailState?.pending && !expectedState) return false;
  if (expectedState && detailState !== expectedState) return false;
  const modal = document.getElementById('feedbackDetailModal');
  const shouldRestoreFocus = modal.contains(document.activeElement);
  const trigger = detailState?.trigger;
  modal.classList.add('hidden');
  detailTrap?.deactivate();
  selected = null;
  detailState = null;
  if (shouldRestoreFocus) restoreDetailFocus(trigger);
  return true;
}

function renderDetail(item, { preserve = false } = {}) {
  const modal = document.getElementById('feedbackDetailModal');
  const previousFocus = preserve && modal.contains(document.activeElement) ? {
    id: document.activeElement.id,
    start: document.activeElement.selectionStart,
    end: document.activeElement.selectionEnd,
  } : null;
  const savedStatus = preserve ? document.getElementById('detailStatus')?.value : null;
  const savedNote = preserve ? document.getElementById('detailNote')?.value : null;
  selected = item;
  const body = document.getElementById('feedbackDetailBody'); body.textContent = '';
  const meta = document.createElement('p'); meta.className = 'feedback-detail-meta'; meta.textContent = `${typeLabel(item.type)} · ${item.author_email} · ${item.pathname} · ${formatDate(String(item.created_at).slice(0, 10), context.i18n.language)}`;
  const copy = document.createElement('p'); copy.className = 'feedback-detail-copy'; copy.textContent = item.description;
  const statusField = document.createElement('div'); statusField.className = 'field'; const label = document.createElement('label'); label.className = 'field-label'; label.htmlFor = 'detailStatus'; label.textContent = t('feedbackAdmin.status'); const select = document.createElement('select'); select.id = 'detailStatus'; for (const value of ['new', 'in_progress', 'resolved']) { const option = document.createElement('option'); option.value = value; option.textContent = statusLabel(value); select.appendChild(option); } statusField.append(label, select);
  const noteField = document.createElement('div'); noteField.className = 'field'; const noteLabel = document.createElement('label'); noteLabel.className = 'field-label'; noteLabel.htmlFor = 'detailNote'; noteLabel.textContent = t('feedbackAdmin.internalNote'); const note = document.createElement('textarea'); note.id = 'detailNote'; note.maxLength = 5000; note.value = savedNote ?? item.internal_note ?? ''; noteField.append(noteLabel, note);
  body.append(meta, copy, statusField, noteField);
  select.value = savedStatus ?? item.status;
  const pending = detailState?.pending;
  select.disabled = pending; note.disabled = pending;
  document.getElementById('feedbackDetailSave').disabled = pending;
  document.getElementById('feedbackDetailDelete').disabled = pending;
  document.getElementById('feedbackDetailClose').disabled = pending;
  modal.classList.remove('hidden');
  detailTrap = detailTrap || createDialogFocusTrap(modal, closeDetail);
  if (!preserve) { detailTrap.activate(); select.focus(); }
  if (preserve && previousFocus?.id) {
    const focused = document.getElementById(previousFocus.id);
    focused?.focus();
    if (focused && typeof previousFocus.start === 'number' && 'selectionStart' in focused) focused.setSelectionRange(previousFocus.start, previousFocus.end);
  }
  refreshIcons();
}

function openDetail(item, trigger) {
  if (detailState?.pending) return;
  detailState = { id: item.id, item, trigger, pending: false };
  renderDetail(item);
}

function translatePendingDetail(item) {
  const meta = document.querySelector('#feedbackDetailBody .feedback-detail-meta');
  if (meta) meta.textContent = `${typeLabel(item.type)} · ${item.author_email} · ${item.pathname} · ${formatDate(String(item.created_at).slice(0, 10), context.i18n.language)}`;
  const statusLabelElement = document.querySelector('#feedbackDetailBody label[for="detailStatus"]');
  const noteLabelElement = document.querySelector('#feedbackDetailBody label[for="detailNote"]');
  if (statusLabelElement) statusLabelElement.textContent = t('feedbackAdmin.status');
  if (noteLabelElement) noteLabelElement.textContent = t('feedbackAdmin.internalNote');
  document.querySelectorAll('#detailStatus option').forEach((option) => { option.textContent = statusLabel(option.value); });
}

async function saveDetail() {
  const target = detailState;
  if (!target || target.pending || !selected) return;
  const status = document.getElementById('detailStatus').value;
  const internalNote = document.getElementById('detailNote').value;
  target.pending = true;
  renderDetail(target.item, { preserve: true });
  try {
    await updateAdminFeedback(target.id, { status, internal_note: internalNote });
    if (detailState !== target) return;
    closeDetail({ expectedState: target });
    const focusAtRefresh = document.activeElement;
    const refreshed = await load(true);
    if (refreshed === LOAD_RESULT.success) restoreFocusAfterRefresh(target.trigger, focusAtRefresh);
    showToast('feedbackAdmin.saved');
    if (refreshed === LOAD_RESULT.failed) setState({ error: true, empty: false });
  } catch (error) {
    if (detailState === target) {
      target.pending = false;
      renderDetail(target.item, { preserve: true });
      showToast(errorKey(error), true);
    }
  }
}

async function deleteDetail() {
  const target = detailState;
  if (!target || target.pending || !selected) return;
  const confirmed = await showConfirm({ title: t('feedbackAdmin.deleteTitle'), message: t('feedbackAdmin.deleteConfirm'), confirmLabel: t('feedbackAdmin.delete'), cancelLabel: t('feedbackAdmin.cancel') });
  if (!confirmed || detailState !== target) return;
  target.pending = true;
  renderDetail(target.item, { preserve: true });
  try {
    await deleteAdminFeedback(target.id);
    if (detailState !== target) return;
    closeDetail({ expectedState: target });
    const focusAtRefresh = document.activeElement;
    context.rows = context.rows.filter((item) => item.id !== target.id);
    renderRows(context.rows);
    setState({ empty: context.rows.length === 0 });
    const refreshed = await load(true);
    if (refreshed === LOAD_RESULT.success) restoreFocusAfterRefresh(target.trigger, focusAtRefresh);
    showToast('feedbackAdmin.deleted');
    if (refreshed === LOAD_RESULT.failed) setState({ error: true, empty: false });
  } catch (error) {
    if (detailState === target) {
      target.pending = false;
      renderDetail(target.item, { preserve: true });
      showToast(errorKey(error), true);
    }
  }
}

export async function initAdminFeedback() {
  const user = await initShell({ active: 'admin-feedback' }); if (!user) return null;
  context = { i18n: getShellI18n(), rows: [], page: 1, total: 0, generation: 0, requestId: 0, loading: false, state: { loading: false, error: false, empty: false } };
  document.getElementById('feedbackStatusFilter').addEventListener('change', () => load(true));
  document.getElementById('feedbackTypeFilter').addEventListener('change', () => load(true));
  document.getElementById('feedbackAdminRetry').addEventListener('click', () => load(true));
  document.getElementById('feedbackLoadMore').addEventListener('click', () => load(false));
  document.getElementById('feedbackDetailClose').addEventListener('click', closeDetail);
  document.getElementById('feedbackDetailModal').addEventListener('click', (event) => { if (event.target.id === 'feedbackDetailModal') closeDetail(); });
  document.getElementById('feedbackDetailSave').addEventListener('click', saveDetail);
  document.getElementById('feedbackDetailDelete').addEventListener('click', deleteDetail);
  document.addEventListener('app:languagechange', () => {
    context.i18n = getShellI18n();
    renderRows(context.rows);
    if (detailState?.pending) translatePendingDetail(detailState.item);
    else if (detailState) renderDetail(detailState.item, { preserve: true });
  });
  await load(true); return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) initAdminFeedback().catch(() => window.location.replace('/login.html'));
