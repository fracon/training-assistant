import { getShellI18n, initShell, refreshIcons, showConfirm } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { createDialogFocusTrap } from './shared/dialog-focus.js';
import { deleteAdminFeedback, fetchAdminFeedback, updateAdminFeedback } from './shared/api.js';

let context;
let detailTrap;
let selected;

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
    const view = document.createElement('button'); view.type = 'button'; view.className = 'btn-secondary'; view.dataset.id = item.id; view.dataset.i18n = 'feedbackAdmin.view'; view.textContent = t('feedbackAdmin.view'); view.addEventListener('click', () => openDetail(item));
    bottom.append(meta, view); row.appendChild(bottom); list.appendChild(row);
  }
  refreshIcons();
}

function setState(state) {
  document.getElementById('feedbackAdminLoading').classList.toggle('hidden', !state.loading);
  document.getElementById('feedbackAdminError').classList.toggle('hidden', !state.error);
  document.getElementById('feedbackAdminEmpty').classList.toggle('hidden', !state.empty);
}

async function load(reset = true) {
  if (reset) context.page = 1;
  setState({ loading: true });
  try {
    const payload = await fetchAdminFeedback({ status: document.getElementById('feedbackStatusFilter').value, type: document.getElementById('feedbackTypeFilter').value, page: context.page, limit: 25 });
    context.rows = reset ? payload.feedback : [...context.rows, ...payload.feedback];
    renderRows(context.rows); setState({ empty: context.rows.length === 0 });
    const more = document.getElementById('feedbackLoadMore'); more.classList.toggle('hidden', context.rows.length >= payload.total); more.disabled = false;
  } catch (error) { setState({ error: true }); }
}

function closeDetail() { const modal = document.getElementById('feedbackDetailModal'); modal.classList.add('hidden'); detailTrap?.deactivate(); selected = null; }

function openDetail(item) {
  selected = item;
  const body = document.getElementById('feedbackDetailBody'); body.textContent = '';
  const meta = document.createElement('p'); meta.className = 'feedback-detail-meta'; meta.textContent = `${typeLabel(item.type)} · ${item.author_email} · ${item.pathname} · ${formatDate(String(item.created_at).slice(0, 10), context.i18n.language)}`;
  const copy = document.createElement('p'); copy.className = 'feedback-detail-copy'; copy.textContent = item.description;
  const statusField = document.createElement('div'); statusField.className = 'field'; const label = document.createElement('label'); label.className = 'field-label'; label.htmlFor = 'detailStatus'; label.textContent = t('feedbackAdmin.status'); const select = document.createElement('select'); select.id = 'detailStatus'; for (const value of ['new', 'in_progress', 'resolved']) { const option = document.createElement('option'); option.value = value; option.textContent = statusLabel(value); option.selected = value === item.status; select.appendChild(option); } statusField.append(label, select);
  const noteField = document.createElement('div'); noteField.className = 'field'; const noteLabel = document.createElement('label'); noteLabel.className = 'field-label'; noteLabel.htmlFor = 'detailNote'; noteLabel.textContent = t('feedbackAdmin.internalNote'); const note = document.createElement('textarea'); note.id = 'detailNote'; note.maxLength = 5000; note.value = item.internal_note || ''; noteField.append(noteLabel, note);
  body.append(meta, copy, statusField, noteField);
  document.getElementById('feedbackDetailModal').classList.remove('hidden');
  detailTrap = detailTrap || createDialogFocusTrap(document.getElementById('feedbackDetailModal'), closeDetail); detailTrap.activate(); select.focus(); refreshIcons();
}

async function saveDetail() { if (!selected) return; const button = document.getElementById('feedbackDetailSave'); button.disabled = true; try { const result = await updateAdminFeedback(selected.id, { status: document.getElementById('detailStatus').value, internal_note: document.getElementById('detailNote').value }); context.rows = context.rows.map((item) => item.id === result.feedback.id ? result.feedback : item); renderRows(context.rows); closeDetail(); showToast('feedbackAdmin.saved'); } catch (error) { showToast(errorKey(error), true); } finally { button.disabled = false; } }

async function deleteDetail() { if (!selected) return; const confirmed = await showConfirm({ title: t('feedbackAdmin.deleteTitle'), message: t('feedbackAdmin.deleteConfirm'), confirmLabel: t('feedbackAdmin.delete'), cancelLabel: t('feedbackAdmin.cancel') }); if (!confirmed) return; try { await deleteAdminFeedback(selected.id); context.rows = context.rows.filter((item) => item.id !== selected.id); closeDetail(); renderRows(context.rows); setState({ empty: context.rows.length === 0 }); showToast('feedbackAdmin.deleted'); } catch (error) { showToast(errorKey(error), true); } }

export async function initAdminFeedback() {
  const user = await initShell({ active: 'admin-feedback' }); if (!user) return null;
  context = { i18n: getShellI18n(), rows: [], page: 1 };
  document.getElementById('feedbackStatusFilter').addEventListener('change', () => load(true)); document.getElementById('feedbackTypeFilter').addEventListener('change', () => load(true)); document.getElementById('feedbackAdminRetry').addEventListener('click', () => load(true)); document.getElementById('feedbackLoadMore').addEventListener('click', () => { context.page += 1; load(false); }); document.getElementById('feedbackDetailClose').addEventListener('click', closeDetail); document.getElementById('feedbackDetailModal').addEventListener('click', (event) => { if (event.target.id === 'feedbackDetailModal') closeDetail(); }); document.getElementById('feedbackDetailSave').addEventListener('click', saveDetail); document.getElementById('feedbackDetailDelete').addEventListener('click', deleteDetail);
  document.addEventListener('app:languagechange', () => { context.i18n = getShellI18n(); renderRows(context.rows); if (selected) openDetail(selected); });
  await load(true); return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) initAdminFeedback().catch(() => window.location.replace('/login.html'));
