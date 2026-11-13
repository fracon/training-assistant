import { getShellI18n, initShell, refreshIcons, showShellToast } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { dateLocale, formatDateTime } from './shared/date.js';
import { createDialogFocusTrap } from './shared/dialog-focus.js';
import { copyPromptText } from './shared/workout-prompts.js';
import { fetchAdminAiAccounts, fetchAdminAiExecution, fetchAdminAiExecutions } from './shared/api.js';

// Administration > Prompt history (issue #113). Read-only: the page lists the
// AI executions of one account at a time and opens one execution's full trace.
// The backend audits every detail read of another account's execution.

const PAGE_SIZE = 25;
const $ = (id) => document.getElementById(id);
let ctx;

function t(key, params) { return translate(ctx.i18n.messages, `aiHistory.${key}`, params); }

function accountName(account) {
  const name = [account.first_name, account.last_name].filter(Boolean).join(' ').trim();
  return name ? `${name} (${account.email})` : account.email;
}

function formatCost(value) {
  return new Intl.NumberFormat(dateLocale(ctx.i18n.language), {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(Number(value) || 0);
}

function badge(text, className) {
  const element = document.createElement('span');
  element.className = `ai-history-badge ${className}`;
  element.textContent = text;
  return element;
}

function accountBadges(account) {
  const badges = [];
  if (account.role === 'admin') badges.push(badge(t('admin'), 'account-admin'));
  if (!account.is_active) badges.push(badge(t('inactive'), 'account-inactive'));
  return badges;
}

// ── Account selector ─────────────────────────────────────────────

function renderAccounts() {
  const select = $('aiHistoryAccount');
  select.textContent = '';
  for (const account of ctx.accounts) {
    const option = document.createElement('option');
    option.value = String(account.id);
    const tags = [account.role === 'admin' ? t('admin') : '', account.is_active ? '' : t('inactive')].filter(Boolean);
    option.textContent = [t('accountOption', { name: accountName(account), count: account.execution_count }), ...tags].join(' · ');
    select.appendChild(option);
  }
  if (ctx.accountId) select.value = String(ctx.accountId);
  select.disabled = ctx.accounts.length === 0;
}

function readAccountFromUrl() {
  const value = new URLSearchParams(window.location.search).get('account');
  return /^\d+$/.test(value || '') ? Number(value) : null;
}

function writeAccountToUrl(id) {
  const url = new URL(window.location.href);
  url.searchParams.set('account', String(id));
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

async function loadAccounts() {
  setListState({ loading: 'loadingAccounts', error: false, empty: null });
  try {
    const payload = await fetchAdminAiAccounts();
    ctx.accounts = payload.accounts;
    const requested = readAccountFromUrl();
    const chosen = ctx.accounts.find((account) => account.id === requested) || ctx.accounts[0];
    ctx.accountId = chosen?.id ?? null;
    renderAccounts();
    if (!chosen) {
      setListState({ loading: null, error: false, empty: 'noAccounts' });
      return;
    }
    await loadExecutions(true);
  } catch {
    ctx.retry = loadAccounts;
    setListState({ loading: null, error: true, empty: null });
  }
}

// ── Execution list ───────────────────────────────────────────────

function setListState({ loading, error, empty }) {
  ctx.listState = { loading, error, empty };
  $('aiHistoryLoading').textContent = loading ? t(loading) : '';
  $('aiHistoryError').classList.toggle('hidden', !error);
  $('aiHistoryEmpty').textContent = empty ? t(empty) : '';
  $('aiHistoryEmpty').classList.toggle('hidden', !empty);
}

function rowMeta(row) {
  const meta = document.createElement('p');
  meta.className = 'ai-history-meta';
  const parts = [
    formatDateTime(row.created_at, ctx.i18n.language),
    row.prompt_version,
    `${t('fields.attempts')}: ${row.attempts}`,
    t('tokensValue', { count: row.charged_tokens }),
    formatCost(row.charged_cost),
  ];
  meta.textContent = parts.join(' · ');
  if (row.error_code) {
    const error = document.createElement('span');
    error.className = 'ai-history-error-code';
    error.textContent = ` · ${row.error_code}`;
    meta.appendChild(error);
  }
  return meta;
}

function renderRows() {
  const list = $('aiHistoryList');
  // A rerender (language change, next page) keeps focus on the same row action.
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  list.textContent = '';
  for (const row of ctx.rows) {
    const item = document.createElement('li');
    item.className = 'ai-history-row';
    item.dataset.id = row.id;
    const main = document.createElement('div');
    main.className = 'ai-history-row-main';
    const top = document.createElement('div');
    top.className = 'ai-history-row-top';
    const purpose = document.createElement('strong');
    purpose.textContent = t(`purposes.${row.purpose}`);
    top.append(purpose, badge(t(`states.${row.state}`), `state-${row.state}`));
    main.append(top, rowMeta(row));
    const actions = document.createElement('div');
    actions.className = 'ai-history-row-actions';
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'btn-icon';
    view.dataset.id = row.id;
    view.setAttribute('aria-label', t('viewAccessible'));
    view.innerHTML = '<i data-lucide="eye"></i>';
    const tooltip = document.createElement('div');
    tooltip.className = 'custom-tooltip';
    tooltip.setAttribute('aria-hidden', 'true');
    tooltip.textContent = t('viewAccessible');
    view.appendChild(tooltip);
    view.addEventListener('click', () => openDetail(row.id, view));
    actions.appendChild(view);
    item.append(main, actions);
    list.appendChild(item);
  }
  if (focusedId) list.querySelector(`button[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  refreshIcons();
}

async function loadExecutions(reset) {
  if (!ctx.accountId) return;
  if (!reset && ctx.loading) return;
  if (reset) {
    ctx.generation += 1;
    ctx.rows = [];
    ctx.page = 0;
    ctx.total = 0;
    renderRows();
  }
  const generation = ctx.generation;
  const page = ctx.page + 1;
  const more = $('aiHistoryLoadMore');
  ctx.loading = true;
  more.disabled = true;
  if (reset) more.classList.add('hidden');
  setListState({ loading: 'loading', error: false, empty: null });
  try {
    const payload = await fetchAdminAiExecutions(ctx.accountId, {
      purpose: $('aiHistoryPurpose').value,
      state: $('aiHistoryState').value,
      page,
      limit: PAGE_SIZE,
    });
    if (generation !== ctx.generation) return;
    const seen = new Set(ctx.rows.map((row) => row.id));
    ctx.rows = [...ctx.rows, ...payload.executions.filter((row) => !seen.has(row.id))];
    ctx.page = page;
    ctx.total = payload.total;
    renderRows();
    setListState({ loading: null, error: false, empty: ctx.rows.length ? null : 'empty' });
    more.classList.toggle('hidden', ctx.rows.length >= ctx.total);
  } catch {
    if (generation !== ctx.generation) return;
    ctx.retry = () => loadExecutions(true);
    setListState({ loading: null, error: true, empty: null });
    more.classList.add('hidden');
  } finally {
    if (generation === ctx.generation) {
      ctx.loading = false;
      more.disabled = false;
    }
  }
}

// ── Execution detail ─────────────────────────────────────────────

function isVisible(element) {
  return Boolean(element?.isConnected && !element.hidden && getComputedStyle(element).display !== 'none');
}

function closeDetail() {
  const detail = ctx.detail;
  if (!detail) return;
  const modal = $('aiExecutionModal');
  const restore = modal.contains(document.activeElement) || document.activeElement === document.body;
  clearTimeout(ctx.expiryTimer);
  modal.classList.add('hidden');
  ctx.trap.deactivate();
  ctx.detail = null;
  if (!restore) return;
  let target = detail.trigger;
  if (!isVisible(target)) target = document.querySelector(`#aiHistoryList button[data-id="${CSS.escape(detail.id)}"]`) || document.querySelector('#aiHistoryList button[data-id]') || $('aiHistoryAccount');
  target?.focus();
}

function selectTab(tab, focus = false) {
  for (const [id, panel] of [['traceRequestTab', 'traceRequestPanel'], ['traceResponseTab', 'traceResponsePanel']]) {
    const selected = id === tab;
    $(id).setAttribute('aria-selected', String(selected));
    if (selected) $(id).removeAttribute('tabindex'); else $(id).tabIndex = -1;
    $(panel).hidden = !selected;
  }
  if (focus) $(tab).focus();
}

function attemptOf(execution, attempt) {
  return {
    diagnostic: execution.diagnostics?.find((item) => item.attempt === attempt),
    raw: execution.rawOutputs?.find((item) => item.attempt === attempt),
  };
}

function rawExpired(raw) {
  return Boolean(raw) && (raw.expired === 1 || !Number.isFinite(Date.parse(raw.expires_at)) || Date.parse(raw.expires_at) <= Date.now());
}

function attemptSucceeded(execution, diagnostic) {
  return diagnostic?.stage === 'completed' && diagnostic.code === 'completed' && execution.response !== null && execution.response !== undefined;
}

// What the selected attempt can show and copy. A raw capture wins; otherwise a
// validated response; an expired capture is never shown or copied.
function attemptOutput(execution, attempt) {
  const { diagnostic, raw } = attemptOf(execution, attempt);
  const successful = attemptSucceeded(execution, diagnostic);
  const expired = rawExpired(raw);
  if (raw && expired) return { text: t('trace.expired'), copy: null, raw, expired };
  if (raw && typeof raw.output_text === 'string')
    return { text: raw.output_text + (raw.truncated ? `\n\n${t('trace.truncated')}` : ''), copy: raw.output_text, raw, expired };
  if (!raw && successful) {
    const json = JSON.stringify(execution.response, null, 2);
    return { text: json, copy: json, raw, expired };
  }
  if (!raw && execution.rawOutputCaptureVersion === 0) return { text: t('trace.legacy'), copy: null, raw, expired };
  return { text: t('trace.noOutput'), copy: null, raw, expired };
}

function renderTrace() {
  clearTimeout(ctx.expiryTimer);
  const execution = ctx.detail?.execution;
  if (!execution) return;
  const attempt = Number($('traceAttempt').value);
  const { diagnostic } = attemptOf(execution, attempt);
  const successful = attemptSucceeded(execution, diagnostic);
  const validation = diagnostic?.validation;
  const parsing = diagnostic?.parse;
  const reason = validation?.reason ? t(`trace.reasons.${validation.reason}`) : parsing?.code ? t(`trace.reasons.${parsing.code}`) : '';
  const status = successful ? t('states.completed') : diagnostic ? t('trace.failed') : t('trace.noAttemptInfo');
  const stage = diagnostic?.stage === 'completed' ? '' : diagnostic?.stage || '';
  const code = validation?.code || parsing?.code || (diagnostic?.code === 'completed' ? '' : diagnostic?.code || '');
  $('traceDiagnosis').textContent = [status, stage, code, reason, validation?.path || parsing?.path || ''].filter(Boolean).join(' · ');
  const output = attemptOutput(execution, attempt);
  $('traceOutput').textContent = output.text;
  $('traceCopy').disabled = typeof output.copy !== 'string';
  if (output.raw && !output.expired) {
    const remaining = Date.parse(output.raw.expires_at) - Date.now();
    ctx.expiryTimer = setTimeout(renderTrace, Math.max(1, remaining + 1));
  }
}

function metaItem(label, value) {
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (Array.isArray(value)) dd.append(...value); else dd.textContent = value;
  wrapper.append(dt, dd);
  return wrapper;
}

function renderDetailContent() {
  const execution = ctx.detail.execution;
  const ownExecution = execution.account.id === ctx.user.id;
  $('aiExecutionMeta').replaceChildren(
    metaItem(t('fields.account'), [document.createTextNode(accountName(execution.account)), ...accountBadges(execution.account)]),
    metaItem(t('purpose'), t(`purposes.${execution.purpose}`)),
    metaItem(t('state'), [badge(t(`states.${execution.state}`), `state-${execution.state}`)]),
    metaItem(t('fields.created'), formatDateTime(execution.created_at, ctx.i18n.language)),
    metaItem(t('fields.attempts'), String(execution.attempts)),
    metaItem(t('fields.tokens'), String(execution.charged_tokens)),
    metaItem(t('fields.cost'), formatCost(execution.charged_cost)),
    metaItem(t('fields.version'), execution.prompt_version),
    metaItem(t('fields.resource'), execution.resource_id || '—'),
    metaItem(t('fields.error'), execution.error_code || t('noError')),
  );
  $('aiExecutionAudit').textContent = ownExecution ? t('ownExecution') : t('audited');
  $('aiExecutionPrompt').textContent = execution.externalPrompt;
  $('aiExecutionContext').textContent = JSON.stringify(execution.context, null, 2);
  $('aiExecutionPayload').textContent = JSON.stringify(execution.payload, null, 2);
  $('aiExecutionConfiguration').textContent = JSON.stringify(execution.configuration, null, 2);
  const select = $('traceAttempt');
  const selected = select.value;
  select.textContent = '';
  const attempts = [...new Set([...(execution.diagnostics || []).map((item) => item.attempt), ...(execution.rawOutputs || []).map((item) => item.attempt)])].sort((a, b) => a - b);
  for (const attempt of attempts) {
    const option = document.createElement('option');
    option.value = String(attempt);
    option.textContent = `${t('trace.attempt')} ${attempt}`;
    select.appendChild(option);
  }
  if (!attempts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = t('trace.noAttempt');
    select.appendChild(option);
  } else {
    select.value = attempts.map(String).includes(selected) && ctx.detail.rendered ? selected : String(attempts.at(-1));
  }
  ctx.detail.rendered = true;
  renderTrace();
}

function renderDetailStatus() {
  const detail = ctx.detail;
  const status = $('aiExecutionStatus');
  status.classList.remove('hidden');
  if (detail.execution) {
    status.textContent = '';
    status.removeAttribute('role');
    $('aiExecutionContent').hidden = false;
    renderDetailContent();
    return;
  }
  $('aiExecutionContent').hidden = true;
  status.setAttribute('role', detail.error ? 'alert' : 'status');
  status.textContent = detail.error ? t(detail.error) : t('detailLoading');
}

async function openDetail(id, trigger) {
  const requestId = ++ctx.detailRequest;
  ctx.detail = { id, trigger, execution: null, error: null, rendered: false };
  for (const section of document.querySelectorAll('.ai-execution-section')) section.open = false;
  selectTab('traceRequestTab');
  $('traceAttempt').textContent = '';
  renderDetailStatus();
  $('aiExecutionModal').classList.remove('hidden');
  ctx.trap.activate();
  $('aiExecutionTitle').focus();
  refreshIcons();
  try {
    const payload = await fetchAdminAiExecution(id);
    if (requestId !== ctx.detailRequest || ctx.detail?.id !== id) return;
    ctx.detail.execution = payload.execution;
  } catch (error) {
    if (requestId !== ctx.detailRequest || ctx.detail?.id !== id) return;
    ctx.detail.error = error?.codes?.[0] === 'executionNotFound' ? 'notFound' : 'detailError';
  }
  renderDetailStatus();
}

async function copyText(text, successKey) {
  if (typeof text === 'string' && await copyPromptText(text)) showShellToast(ctx.i18n.messages, successKey);
  else showShellToast(ctx.i18n.messages, 'aiHistory.copyError', 'error');
}

export async function initAdminAiHistory() {
  const user = await initShell({ active: 'admin-ai-history' });
  if (!user) return null;
  ctx = {
    user,
    i18n: getShellI18n(),
    accounts: [],
    accountId: null,
    rows: [],
    page: 0,
    total: 0,
    generation: 0,
    loading: false,
    retry: null,
    listState: { loading: null, error: false, empty: null },
    detail: null,
    detailRequest: 0,
    expiryTimer: null,
  };
  ctx.trap = createDialogFocusTrap($('aiExecutionModal'), closeDetail);
  $('aiHistoryAccount').addEventListener('change', (event) => {
    ctx.accountId = Number(event.target.value);
    writeAccountToUrl(ctx.accountId);
    loadExecutions(true);
  });
  $('aiHistoryPurpose').addEventListener('change', () => loadExecutions(true));
  $('aiHistoryState').addEventListener('change', () => loadExecutions(true));
  $('aiHistoryRetry').addEventListener('click', () => ctx.retry?.());
  $('aiHistoryLoadMore').addEventListener('click', () => loadExecutions(false));
  $('aiExecutionClose').addEventListener('click', closeDetail);
  $('aiExecutionModal').addEventListener('click', (event) => { if (event.target.id === 'aiExecutionModal') closeDetail(); });
  for (const tab of ['traceRequestTab', 'traceResponseTab']) {
    $(tab).addEventListener('click', () => selectTab(tab));
    $(tab).addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? 'traceRequestTab' : event.key === 'End' ? 'traceResponseTab' : tab === 'traceRequestTab' ? 'traceResponseTab' : 'traceRequestTab';
      selectTab(target, true);
    });
  }
  $('traceAttempt').addEventListener('change', renderTrace);
  $('aiExecutionCopyPrompt').addEventListener('click', () => copyText(ctx.detail?.execution?.externalPrompt, 'aiHistory.promptCopied'));
  $('traceCopy').addEventListener('click', () => {
    const execution = ctx.detail?.execution;
    if (!execution) return;
    const output = attemptOutput(execution, Number($('traceAttempt').value));
    // A capture that expired while the dialog was open is re-rendered, never copied.
    if (output.expired || typeof output.copy !== 'string') { renderTrace(); return; }
    copyText(output.copy, 'aiHistory.trace.copied');
  });
  const refreshVisibleTrace = () => { if (!document.hidden) renderTrace(); };
  document.addEventListener('visibilitychange', refreshVisibleTrace);
  window.addEventListener('focus', refreshVisibleTrace);
  document.addEventListener('app:languagechange', () => {
    ctx.i18n = getShellI18n();
    renderAccounts();
    renderRows();
    setListState(ctx.listState);
    if (ctx.detail) renderDetailStatus();
  });
  await loadAccounts();
  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) initAdminAiHistory().catch(() => window.location.replace('/login.html'));
