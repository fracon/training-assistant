import {
  copyPromptText,
  DAY_KEYS,
  DAY_DB_KEYS,
  PERIOD_KEYS,
  MAX_AVAILABLE_MINUTES,
  validateAvailabilityDay,
  DAY_LOCALE_KEYS,
  orderedDayKeys,
  nextMonday,
  dateInputValue,
  availabilityDefaults,
  replaceAll,
  parseInputDate,
} from './shared/workout-prompts.js';
export * from './shared/workout-prompts.js';
import {
  initShell,
  getShellI18n,
  getUserPreferences,
  refreshIcons,
} from './shared/shell.js';
import { translate } from './shared/i18n.js';
import {
  fetchAiCoachAvailability,
  saveAiCoachAvailability,
  fetchAiExecutions,
  fetchAiExecution,
  startAiExecution,
  fetchWeeklyProposal,
  applyWeeklyProposal,
  cancelAiExecution,
  fetchAiAdminPreview,
} from './shared/api.js';
import {
  formatDate as formatLocalizedDate,
  parseLocalizedDate,
} from './shared/date.js';
import { createDatePicker, readDatePickerValue } from './shared/datepicker.js';
import { cleanWeeklyJustification, formatWeeklyWeather, summarizePrescription } from './shared/weekly-prescription-display.js';
import { createDialogFocusTrap } from './shared/dialog-focus.js';

function normalizeTargetDate(value, language) {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = parseInputDate(text);
    return date && dateInputValue(date) === text ? text : '';
  }
  return parseLocalizedDate(text, language);
}

// The DatePicker owns the ISO value; never read the localized display input
// when building the prompt. Its getter also keeps this binding resilient to
// future DatePicker implementations that do not expose a dataset value.
export function readTargetDateIso(input, picker, language = 'pt-BR') {
  const pickerValue = picker?.getValue?.();
  return (
    pickerValue ||
    readDatePickerValue(input) ||
    normalizeTargetDate(input?.value, language)
  );
}

export function validatePromptFields({
  targetDate = '',
  language = 'pt-BR',
  disponibilidade = {},
} = {}) {
  const missing = [];
  if (!normalizeTargetDate(targetDate, language)) missing.push('targetDate');
  const availability = Array.isArray(disponibilidade)
    ? Object.fromEntries(
        disponibilidade.map((record) => [
          DAY_KEYS[DAY_DB_KEYS.indexOf(record.day)],
          record,
        ]),
      )
    : disponibilidade;
  const hasAllDays = DAY_KEYS.every(
    (day) => validateAvailabilityDay(availability[day]).length === 0,
  );
  if (!hasAllDays) missing.push('availability');
  return { valid: missing.length === 0, missing };
}

function daySummary(state, messages) {
  if (state.can_train === false)
    return { text: messages.dayUnavailable || '', incomplete: false };
  if (state.can_train !== true)
    return { text: messages.dayNotConfigured || '', incomplete: false };
  const selectedPeriods =
    Array.isArray(state.available_periods) &&
    state.available_periods.length === 1
      ? state.available_periods
      : [];
  const legacyPeriods =
    Array.isArray(state.legacy_periods) && state.legacy_periods.length > 1
      ? state.legacy_periods
      : Array.isArray(state.available_periods) &&
          state.available_periods.length > 1
        ? state.available_periods
        : [];
  const periods = [...selectedPeriods, ...legacyPeriods].map(
    (period) => messages.periods?.[period] || period,
  );
  const duration = Number.isInteger(state.available_minutes)
    ? `${state.available_minutes} ${messages.minutesUnit || messages.minutes || ''}`
    : '';
  const text =
    [periods.join('; '), duration].filter(Boolean).join(' · ') ||
    messages.dayAvailable ||
    '';
  const incomplete = validateAvailabilityDay(state).length > 0;
  return { text, incomplete };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildDayRowHtml(day, { dayLabel, messages = {}, state = {} }) {
  const dbDay = DAY_DB_KEYS[DAY_KEYS.indexOf(day)];
  const legacyPeriods =
    Array.isArray(state.legacy_periods) && state.legacy_periods.length > 1
      ? state.legacy_periods
      : Array.isArray(state.available_periods) &&
          state.available_periods.length > 1
        ? state.available_periods
        : [];
  const selectedPeriod =
    state.available_periods?.length === 1 && legacyPeriods.length === 0
      ? state.available_periods[0]
      : '';
  const periods = PERIOD_KEYS.map(
    (period) =>
      `<label class="period-option"><input type="radio" name="availability-${dbDay}-period" data-period="${period}" ${selectedPeriod === period ? 'checked' : ''}><span>${messages.periods?.[period] || period}</span></label>`,
  ).join('');
  const legacyLabels = legacyPeriods
    .map((period) => messages.periods?.[period] || period)
    .map(escapeHtml)
    .join('; ');
  const legacySummary =
    legacyPeriods.length > 1
      ? `<div class="legacy-period-summary" data-legacy-period-summary role="note"><strong>${escapeHtml(messages.legacyPeriodsLabel || '')}</strong><span>${legacyLabels}</span><p>${escapeHtml(messages.legacyPeriodsHint || '')}</p></div>`
      : '';
  const duration = state.available_minutes ?? '';
  const summary = daySummary(
    { ...state, legacy_periods: legacyPeriods },
    messages,
  );
  const available = state.can_train === true;
  const expanded = state.expanded === true;
  const detailsId = `availability-details-${dbDay}`;
  const durationId = `availability-${dbDay}-duration`;
  const durationHintId = `availability-${dbDay}-duration-hint`;
  const locationId = `availability-${dbDay}-location`;
  const configured = state.can_train !== null && state.can_train !== undefined;
  const expandLabel =
    `${expanded ? messages.dayCollapse || '' : messages.dayExpand || ''} ${dayLabel}`.trim();
  const copyAction =
    day === 'segunda'
      ? `<button type="button" id="applyWeekdays" class="day-copy-action"><i data-lucide="copy" aria-hidden="true"></i><span>${messages.applyWeekdays || ''}</span></button>`
      : '';
  const location = String(state.location || '');
  const locationSummary = `<span class="day-location-summary" data-day-location-summary${location ? '' : ' hidden'}>${location ? '<i data-lucide="map-pin" aria-hidden="true"></i>' : ''}${location ? `<span>${escapeHtml(location)}</span>` : ''}</span>`;
  return `<fieldset class="day-row" data-day="${dbDay}" data-legacy-periods="${escapeHtml(JSON.stringify(legacyPeriods))}">
  <div class="day-summary${expanded ? ' is-expanded' : ''}">
    <div class="day-toggle"><input type="checkbox" data-can-train aria-label="${dayLabel}" ${available ? 'checked' : ''} aria-controls="${detailsId}" ${configured ? 'data-configured="true"' : ''}><span class="day-label">${dayLabel}</span></div>
    <div class="day-summary-copy"><span data-day-summary>${summary.text}</span>${locationSummary}${summary.incomplete ? `<span class="day-incomplete" data-day-incomplete>${messages.dayIncomplete || ''}</span>` : ''}</div>
    <button type="button" class="day-expand" data-expand aria-label="${expandLabel}" aria-controls="${detailsId}" aria-expanded="${expanded ? 'true' : 'false'}"><i data-lucide="chevron-down" class="day-expand-icon" aria-hidden="true"></i></button>
  </div>
  <div class="day-details" id="${detailsId}" ${expanded ? '' : 'hidden'}>
    <fieldset class="period-group"><legend>${messages.periodsLabel || ''}</legend>${legacySummary}<div class="period-list">${periods}</div></fieldset>
    <div class="field availability-day-field"><label class="field-label" for="${durationId}">${messages.durationLabel || ''}</label><input id="${durationId}" type="number" data-duration data-hint-id="${durationHintId}" min="1" max="${MAX_AVAILABLE_MINUTES}" step="1" inputmode="numeric" value="${duration}" placeholder="${messages.durationPlaceholder || ''}" aria-describedby="${durationHintId}"><p class="field-hint" id="${durationHintId}">${messages.durationHint || ''}</p></div>
    <div class="field availability-day-field"><label class="field-label" for="${locationId}">${messages.locationLabel || ''}</label><input id="${locationId}" type="text" data-location value="${String(
      state.location || '',
    )
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')}" autocomplete="off"></div>
  <ul class="day-error" id="availability-error-${dbDay}" data-day-error hidden></ul>
  ${copyAction}
  </div>
</fieldset>`;
}

const COPY_FEEDBACK_MS = 2000;
const WEEKLY_MAX_POLLS = 20;

function setupAiCoachPage(user) {
  const i18n = getShellI18n();

  function t(key) {
    return translate(i18n.messages, key);
  }

  const form = document.getElementById('promptForm');
  const targetDateInput = document.getElementById('targetDate');
  const targetDateDisplay = document.getElementById('targetDateDisplay');
  const optionalContextInput = document.getElementById('optionalContext');
  const baseLocationInput = document.getElementById('baseLocation');
  const availabilityGrid = document.getElementById('availabilityGrid');
  const saveAvailabilityButton = document.getElementById('saveAvailability');
  const availabilityStatus = document.getElementById('availabilityStatus');
  const saveAvailabilityLabel = document.getElementById(
    'saveAvailabilityLabel',
  );
  const availabilityError = document.getElementById('availabilityError');
  const availabilityRetry = document.getElementById('availabilityRetry');
  const availabilityReview = document.getElementById('availabilityReview');
  const promptOutput = document.getElementById('promptOutput');
  const promptModal = document.getElementById('externalPromptModal');
  const promptClose = document.getElementById('externalPromptClose');
  const promptCloseAction = document.getElementById('closePromptBtn');
  const promptCopyStatus = document.getElementById('promptCopyStatus');
  const copyBtn = document.getElementById('copyBtn');
  const copyIcon = document.getElementById('copyIcon');
  const generateBtn = document.getElementById('generateBtn');
  const externalPromptBtn = document.getElementById('externalPromptBtn');
  const weeklySection = document.getElementById('weeklyProposalSection');
  const weeklyStatus = document.getElementById('weeklyProposalStatus');
  const weeklyError = document.getElementById('weeklyProposalError');
  const weeklyContent = document.getElementById('weeklyProposalContent');
  const weeklyApply = document.getElementById('weeklyApply');
  const weeklyReadAgain = document.getElementById('weeklyReadAgain');
  const weeklyCancel = document.getElementById('weeklyCancel');
  const weeklyActions = document.getElementById('weeklyProposalActions');
  const applyResultModal = document.getElementById('weeklyApplyResultModal');
  const applyResultTitle = document.getElementById('weeklyApplyResultTitle');
  const applyResultMessage = document.getElementById('weeklyApplyResultMessage');
  const applyResultIgnored = document.getElementById('weeklyApplyResultIgnored');
  const applyResultClose = document.getElementById('weeklyApplyResultClose');
  const applyResultOk = document.getElementById('weeklyApplyResultOk');
  const isAdmin = user?.role === 'admin';
  if (!isAdmin) {
    externalPromptBtn.remove();
    promptModal.remove();
  } else externalPromptBtn.hidden = false;
  let activeExecutionId = null,
    readAttempt = 0,
    pollTimer = null,
    lastWeeklyState = '',
    weeklyHistoryState = 'loading',
    weeklyReadUnavailable = false;
  let currentProposal = null,
    actionPending = false,
    applicationStatusUnknown = false,
    promptRequest = 0,
    readyExternalPrompt = null,
    weeklyReadPending = false,
    promptOrigin = null,
    promptCopiedTimer = null,
    applyResult = null,
    applyResultReturnFocus = null;
  const promptFocusTrap = isAdmin
    ? createDialogFocusTrap(promptModal, closeExternalPrompt)
    : null;
  const applyResultFocusTrap = createDialogFocusTrap(
    applyResultModal,
    closeApplyResult,
  );

  function applyResultCopy() {
    if (!applyResult) return;
    if (applyResult.kind === 'success') {
      applyResultTitle.textContent = t('aiCoach.weeklyApplySuccessTitle');
      applyResultMessage.textContent = t('aiCoach.weeklyApplySuccessMessage');
      applyResultIgnored.hidden = !(applyResult.ignored > 0);
      if (applyResult.ignored > 0) {
        applyResultIgnored.textContent = (applyResult.ignored === 1
          ? t('aiCoach.weeklyApplyIgnoredOne')
          : t('aiCoach.weeklyApplyIgnoredMany')).replace(
          '{count}',
          String(applyResult.ignored),
        );
      }
    } else if (applyResult.kind === 'unknown') {
      applyResultTitle.textContent = t('aiCoach.weeklyApplyUnknownTitle');
      applyResultMessage.textContent = t('aiCoach.weeklyApplyUnknownMessage');
      applyResultIgnored.hidden = true;
      applyResultIgnored.textContent = '';
    } else {
      applyResultTitle.textContent = t('aiCoach.weeklyApplyErrorTitle');
      applyResultMessage.textContent = t(
        applyResult.conflict
          ? 'aiCoach.weeklyConflict'
          : 'aiCoach.weeklyApplyError',
      );
      applyResultIgnored.hidden = true;
      applyResultIgnored.textContent = '';
    }
  }

  function closeApplyResult() {
    if (applyResultModal.hidden) return;
    applyResultModal.hidden = true;
    applyResultModal.classList.add('hidden');
    applyResultFocusTrap.deactivate();
    const preferred = applyResultReturnFocus;
    applyResultReturnFocus = null;
    applyResult = null;
    applyResultTitle.textContent = '';
    applyResultMessage.textContent = '';
    applyResultIgnored.textContent = '';
    applyResultIgnored.hidden = true;
    const canFocus = (element) =>
      element?.isConnected &&
      !element.hidden &&
      !element.disabled &&
      getComputedStyle(element).display !== 'none';
    const target = canFocus(preferred)
      ? preferred
      : canFocus(weeklyReadAgain)
        ? weeklyReadAgain
        : canFocus(weeklyApply)
          ? weeklyApply
          : document.getElementById('aiCoachTitle');
    target?.focus({ preventScroll: true });
  }

  function showApplyResult(result, returnFocus) {
    if (!applyResultModal.hidden) return;
    applyResult = result;
    applyResultReturnFocus = returnFocus;
    applyResultCopy();
    applyResultModal.hidden = false;
    applyResultModal.classList.remove('hidden');
    applyResultFocusTrap.activate();
    applyResultOk.focus();
    refreshIcons();
  }

  function closeExternalPrompt() {
    if (!isAdmin || promptModal.hidden) return;
    promptModal.hidden = true;
    promptModal.classList.add('hidden');
    document.body.classList.remove('external-prompt-open');
    promptFocusTrap.deactivate();
    clearTimeout(promptCopiedTimer);
    promptCopiedTimer = null;
    promptCopyStatus.textContent = '';
    copyIcon.setAttribute('data-lucide', 'copy');
    refreshIcons();
    const origin = promptOrigin;
    promptOrigin = null;
    if (origin?.isConnected && !origin.hidden && !origin.disabled) origin.focus();
  }

  function openExternalPrompt(prompt) {
    if (!isAdmin || !prompt) return;
    const promptError = document.getElementById('externalPromptError');
    promptError.hidden = true;
    promptError.textContent = '';
    promptOutput.textContent = prompt;
    promptOutput.scrollTop = 0;
    promptCopyStatus.textContent = '';
    promptModal.hidden = false;
    promptModal.classList.remove('hidden');
    document.body.classList.add('external-prompt-open');
    promptOrigin = externalPromptBtn;
    promptFocusTrap.activate();
    promptClose.focus();
    refreshIcons();
  }

  function syncWeeklyActions() {
    weeklyActions.hidden = [weeklyApply, weeklyReadAgain, weeklyCancel].every(
      (button) => button.hidden,
    );
  }

  function focusIdentity(element) {
    if (!element || element === document.body) return '';
    if (element.id) return `#${element.id}`;
    const row = element.closest?.('[data-day]');
    if (row) {
      for (const attribute of ['data-can-train', 'data-period', 'data-duration', 'data-location', 'data-expand']) {
        const control = element.closest(`[${attribute}]`);
        if (control) return `${row.dataset.day}:${attribute}:${control.dataset.period || ''}`;
      }
    }
    return `${element.tagName}:${element.className || ''}`;
  }

  function renderWeeklyProposal(proposal) {
    if (!proposal) return;
    currentProposal = proposal;
    weeklyContent.replaceChildren();
    const response = proposal.proposal || proposal.response;
    const state = proposal.state;
    weeklyApply.hidden = true;
    weeklyReadAgain.hidden = true;
    weeklyCancel.hidden = true;
    weeklyActions.hidden = true;
    weeklyError.hidden = true;
    if (proposal.application) {
      clearTimeout(pollTimer);
      pollTimer = null;
      applicationStatusUnknown = false;
      weeklySection.hidden = true;
      weeklyStatus.textContent = '';
      weeklyStatus.hidden = true;
      lastWeeklyState = '';
      return;
    }
    weeklySection.hidden = false;
    const statusKey =
      state === 'completed'
        ? 'weeklyCompleted'
        : state === 'queued' && proposal.error === 'providerRateLimited'
          ? 'weeklyWaiting'
          : state === 'queued'
            ? 'weeklyQueued'
            : state === 'running'
              ? 'weeklyLoading'
              : state === 'uncertain'
                ? 'weeklyUncertain'
                : state === 'cancelled'
                  ? 'weeklyCancelDone'
                  : state === 'failed' || state === 'outdated'
                    ? 'weeklyFailed'
                    : null;
    const status = statusKey ? t(`aiCoach.${statusKey}`) : '';
    if (status !== lastWeeklyState) {
      weeklyStatus.textContent = status;
      lastWeeklyState = status;
    }
    weeklyStatus.hidden = !status;
    weeklyApply.hidden = state !== 'completed' || proposal.outdated || !response;
    weeklyApply.disabled = actionPending || Boolean(proposal.application);
    weeklyApply.textContent = t('aiCoach.applyWeekly');
    weeklyCancel.hidden =
      !['queued', 'running'].includes(state) || actionPending;
    weeklyReadAgain.hidden = applicationStatusUnknown
      ? false
      : !['failed', 'uncertain'].includes(state);
    if (proposal.outdated && state === 'completed') {
      weeklyStatus.textContent = t('aiCoach.weeklyConflict');
      lastWeeklyState = weeklyStatus.textContent;
      weeklyStatus.hidden = false;
    }
    syncWeeklyActions();
    if (!response || state !== 'completed') return;
    if (!response.sessions?.length) {
      const empty = document.createElement('p');
      empty.textContent = t('aiCoach.weeklyNoSessions');
      weeklyContent.append(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'weekly-proposal-list';
    for (const session of response.sessions) {
      const article = document.createElement('article');
      article.className = 'weekly-proposal-card';
      const heading = document.createElement('h3');
      heading.textContent = t(
        session.durationEstimated
          ? 'aiCoach.weeklySessionEstimated'
          : 'aiCoach.weeklySession',
      )
        .replace(
          '{weekday}',
          t(
            `aiCoach.days.${DAY_LOCALE_KEYS[DAY_KEYS[DAY_DB_KEYS.indexOf(session.weekday)]]}`,
          ),
        )
        .replace('{type}', session.workout || session.type || '')
        .replace('{date}', formatLocalizedDate(session.date, i18n.language))
        .replace('{period}', t(`aiCoach.periods.${session.period}`))
        .replace('{duration}', String(session.durationMinutes));
      article.append(heading);
      const prescription = summarizePrescription(session.details, {
        language: i18n.language,
        fallbackRpe: session.rpe,
        fallbackHr: session.targetHr,
        hrFallback: t('aiCoach.weeklyNoHrReference'),
      });
      const weatherEvidence = proposal.weatherEvidence?.find(
        (item) => item.weekday === session.weekday,
      );
      const weather = weatherEvidence
        ? formatWeeklyWeather(weatherEvidence, {
            temperatureUnit: proposal.temperatureUnit,
            language: i18n.language,
            translate: t,
          })
        : session.weather;
      const summary = document.createElement('dl');
      summary.className = 'weekly-proposal-summary';
      for (const [label, value] of [
        [t('aiCoach.rpeLabel'), prescription.rpe],
        [t('aiCoach.targetHrLabel'), prescription.hr],
      ]) {
        const group = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        group.append(dt, dd);
        summary.append(group);
      }
      article.append(summary);
      const phases = document.createElement('div');
      phases.className = 'weekly-proposal-phases weekly-proposal-details';
      for (const phase of prescription.phases) {
        const block = document.createElement('section');
        block.className = 'weekly-proposal-phase';
        const title = document.createElement('h4');
        title.textContent = t(`aiCoach.weeklyPhases.${phase.phase}`);
        const duration = document.createElement('p');
        duration.className = 'weekly-phase-duration';
        duration.textContent = phase.duration;
        const instruction = document.createElement('p');
        instruction.textContent = `${t('aiCoach.weeklyExecution')}: ${phase.instruction}`;
        const effort = document.createElement('p');
        effort.className = 'weekly-phase-effort';
        effort.textContent = `${t('aiCoach.weeklyEffort')}: ${phase.effort}`;
        block.append(title, duration, instruction, effort);
        if (phase.recovery) {
          const recovery = document.createElement('p');
          recovery.className = 'weekly-phase-recovery';
          recovery.textContent = `${t('aiCoach.weeklyRecovery')}: ${phase.recovery}`;
          block.append(recovery);
        }
        phases.append(block);
      }
      article.append(phases);
      const metadata = document.createElement('dl');
      metadata.className = 'weekly-proposal-meta';
      const fields = [
        [t('aiCoach.shoeLabel'), session.shoeLabel],
        [t('aiCoach.locationLabel'), session.location],
        [t('aiCoach.weatherLabel'), weather],
      ];
      for (const [label, value] of fields) {
        if (!value) continue;
        const group = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        group.append(dt, dd);
        metadata.append(group);
      }
      if (metadata.childElementCount) article.append(metadata);
      for (const [label, value, className] of [
        [t('aiCoach.weeklyNotes'), session.notes, 'weekly-proposal-notes'],
        [
          t('aiCoach.weeklyRationale'),
          cleanWeeklyJustification(session.justification),
          'weekly-proposal-rationale',
        ],
      ]) {
        if (!value) continue;
        const section = document.createElement('section');
        section.className = `weekly-proposal-text ${className}`;
        const title = document.createElement('h4');
        title.textContent = label;
        const text = document.createElement('p');
        text.textContent = value;
        section.append(title, text);
        article.append(section);
      }
      list.append(article);
    }
    weeklyContent.append(list);
  }
  function showWeeklyReadError() {
    weeklyError.hidden = false;
    weeklyError.textContent = t('aiCoach.weeklyReadError');
    weeklyApply.hidden = true;
    weeklyReadAgain.hidden = false;
    syncWeeklyActions();
  }
  async function refreshWeeklyExecution(
    id,
    token = ++readAttempt,
    pollCount = 0,
  ) {
    try {
      const execution = await fetchAiExecution(id);
      if (token !== readAttempt || activeExecutionId !== id) return;
      const proposal = await fetchWeeklyProposal(id);
      if (token !== readAttempt || activeExecutionId !== id) return;
      weeklyReadUnavailable = false;
      proposal.state = execution.state;
      proposal.response = execution.response;
      proposal.error = execution.error;
      proposal.outdated = execution.outdated;
      renderWeeklyProposal(proposal);
      updateValidation();
      if (['queued', 'running'].includes(execution.state)) {
        if (pollCount >= WEEKLY_MAX_POLLS) {
          weeklyReadUnavailable = true;
          weeklyStatus.textContent = t('aiCoach.weeklyStillRunning');
          weeklyReadAgain.hidden = false;
          updateValidation();
          return;
        }
        pollTimer = setTimeout(
          () => void refreshWeeklyExecution(id, token, pollCount + 1),
          1800,
        );
      }
    } catch (error) {
      if (token === readAttempt && activeExecutionId === id) {
        clearTimeout(pollTimer);
        pollTimer = null;
        weeklySection.hidden = false;
        weeklyCancel.hidden = true;
        weeklyReadAgain.hidden = false;
        if (error.codes?.includes('weeklySchemaIncompatible')) {
          weeklyReadUnavailable = false;
          weeklyError.hidden = false;
          weeklyError.textContent = t('aiCoach.weeklySchemaIncompatible');
          weeklyReadAgain.hidden = true;
          syncWeeklyActions();
        } else {
          weeklyReadUnavailable = true;
          showWeeklyReadError();
        }
        updateValidation();
      }
    }
  }
  async function recoverWeeklyExecution() {
    try {
      const executions = await fetchAiExecutions();
      weeklyHistoryState = 'ready';
      const latest = executions.find((entry) => entry.purpose === 'workouts');
      if (latest) {
        activeExecutionId = latest.id;
        void refreshWeeklyExecution(latest.id);
      }
      updateValidation();
    } catch {
      weeklyHistoryState = 'error';
      weeklySection.hidden = false;
      showWeeklyReadError();
      updateValidation();
    }
  }

  async function handleGenerate(event) {
    event.preventDefault();
    if (
      availabilityLoadState !== 'ready' ||
      weeklyHistoryState !== 'ready' ||
      weeklyReadUnavailable ||
      actionPending
    )
      return;
    const validation = updateValidation();
    if (!validation.valid) return;
    const targetIso = readTargetDateIso(
      targetDateInput,
      targetDatePicker,
      i18n.language,
    );
    const submittedSnapshot = currentAvailabilitySnapshot();
    actionPending = true;
    generateBtn.disabled = true;
    if (!(await persistAvailability())) {
      actionPending = false;
      generateBtn.disabled = false;
      updateValidation();
      return;
    }
    if (currentAvailabilitySnapshot() !== submittedSnapshot) {
      actionPending = false;
      generateBtn.disabled = false;
      setAvailabilityStatus('availabilityEditedDuringSave');
      updateValidation();
      return;
    }
    const savedKey = sessionStorage.getItem('kinesis-weekly-request-key');
    if (savedKey) {
      try {
        const list = await fetchAiExecutions();
        const found = list.find((item) => item.idempotency_key === savedKey);
        if (found) {
          activeExecutionId = found.id;
          sessionStorage.removeItem('kinesis-weekly-request-key');
          actionPending = false;
          generateBtn.disabled = false;
          void refreshWeeklyExecution(found.id);
          return;
        }
      } catch {}
      actionPending = false;
      generateBtn.disabled = false;
      weeklySection.hidden = false;
      showWeeklyReadError();
      return;
    }
    const idempotencyKey =
      globalThis.crypto?.randomUUID?.() ||
      `weekly-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('kinesis-weekly-request-key', idempotencyKey);
    try {
      const result = await startAiExecution({
        purpose: 'workouts',
        target_date: targetIso,
        optional_context: optionalContextInput.value,
        idempotency_key: idempotencyKey,
      });
      activeExecutionId = result.id;
      sessionStorage.removeItem('kinesis-weekly-request-key');
      readAttempt += 1;
      weeklySection.hidden = false;
      renderWeeklyProposal({ ...result, weatherEvidence: [] });
      clearTimeout(pollTimer);
      void refreshWeeklyExecution(result.id);
    } catch (error) {
      weeklySection.hidden = false;
      weeklyError.hidden = false;
      const codes = error.codes || [];
      weeklyError.textContent = codes.includes('availabilityNeedsReview')
        ? t('aiCoach.availabilityReview')
        : codes.includes('weeklyAvailabilityConflict')
          ? t('aiCoach.weeklyAvailabilityConflict')
        : codes.some((code) =>
              [
                'aiUnavailable',
                'usageLimit',
                'executionLimit',
                'phaseNotAvailable',
              ].includes(code),
            )
          ? t('aiCoach.weeklyUnavailable')
          : codes.includes('resourceNotFound')
            ? t('aiCoach.weeklyConflict')
            : t('aiCoach.weeklyUncertain');
      weeklyReadAgain.hidden = false;
      if (codes.includes('weeklyAvailabilityConflict')) {
        sessionStorage.removeItem('kinesis-weekly-request-key');
        weeklyReadAgain.hidden = true;
      }
      syncWeeklyActions();
    } finally {
      actionPending = false;
      generateBtn.disabled = false;
      updateValidation();
    }
  }

  async function handleExternalPrompt() {
    if (!isAdmin || availabilityLoadState !== 'ready' || externalPromptBtn.disabled) return;
    if (readyExternalPrompt) {
      const prompt = readyExternalPrompt;
      readyExternalPrompt = null;
      openExternalPrompt(prompt);
      return;
    }
    const validation = updateValidation();
    if (!validation.valid) return;
    const targetIso = readTargetDateIso(
      targetDateInput,
      targetDatePicker,
      i18n.language,
    );
    const request = ++promptRequest;
    const focusAtRequest = document.activeElement;
    const focusKey = focusIdentity(focusAtRequest);
    externalPromptBtn.disabled = true;
    const promptError = document.getElementById('externalPromptError');
    promptError.hidden = true;
    promptError.textContent = '';
    try {
      if (!(await persistAvailability())) return;
      const preview = await fetchAiAdminPreview({
        purpose: 'workouts',
        target_date: targetIso,
        optional_context: optionalContextInput.value,
      });
      if (request !== promptRequest || !isAdmin) return;
      if (
        document.activeElement !== focusAtRequest &&
        document.activeElement !== document.body &&
        document.activeElement !== externalPromptBtn &&
        focusIdentity(document.activeElement) !== focusKey
      ) {
        readyExternalPrompt = preview.prompt;
        promptError.setAttribute('role', 'status');
        promptError.textContent = t('aiCoach.promptReady');
        promptError.hidden = false;
      } else openExternalPrompt(preview.prompt);
    } catch (error) {
      if (request !== promptRequest) return;
      promptError.setAttribute('role', 'alert');
      promptError.hidden = false;
      promptError.textContent = error.codes?.includes('adminRequired')
        ? t('aiCoach.weeklyAdminOnly')
        : t('aiCoach.weeklyReadError');
    } finally {
      if (request === promptRequest) externalPromptBtn.disabled = false;
    }
  }

  weeklyApply.addEventListener('click', async () => {
    if (!activeExecutionId || !currentProposal?.responseHash || actionPending)
      return;
    actionPending = true;
    applicationStatusUnknown = true;
    readAttempt += 1;
    clearTimeout(pollTimer);
    pollTimer = null;
    weeklyApply.disabled = true;
    try {
      const applied = await applyWeeklyProposal(
        activeExecutionId,
        currentProposal.responseHash,
      );
      currentProposal.application = applied;
      applicationStatusUnknown = false;
      renderWeeklyProposal(currentProposal);
      sessionStorage.removeItem('kinesis-weekly-request-key');
      showApplyResult(
        { kind: 'success', ignored: Number(applied.ignored) || 0 },
        document.getElementById('aiCoachTitle'),
      );
    } catch (error) {
      // A lost POST response is resolved by reading this same persisted
      // proposal. It never starts another generation or assumes failure.
      let persisted = null;
      try {
        persisted = await fetchWeeklyProposal(activeExecutionId);
      } catch {}
      if (persisted?.application) {
        currentProposal = { ...currentProposal, ...persisted };
        applicationStatusUnknown = false;
        renderWeeklyProposal(currentProposal);
        sessionStorage.removeItem('kinesis-weekly-request-key');
        showApplyResult(
          {
            kind: 'success',
            ignored: Number(persisted.application.ignored) || 0,
          },
          document.getElementById('aiCoachTitle'),
        );
        return;
      }
      if (persisted) {
        currentProposal = { ...currentProposal, ...persisted };
        applicationStatusUnknown = false;
        renderWeeklyProposal(currentProposal);
      } else {
        applicationStatusUnknown = true;
        weeklyApply.hidden = true;
        weeklyCancel.hidden = true;
        weeklyReadAgain.hidden = false;
        syncWeeklyActions();
      }
      const stale = error.codes?.some(
        (code) => code.includes('Conflict') || code.includes('Outdated'),
      );
      if (stale) {
        weeklyApply.hidden = true;
        await refreshWeeklyExecution(activeExecutionId);
      }
      if (currentProposal?.application) {
        sessionStorage.removeItem('kinesis-weekly-request-key');
        showApplyResult(
          {
            kind: 'success',
            ignored: Number(currentProposal.application.ignored) || 0,
          },
          document.getElementById('aiCoachTitle'),
        );
      } else if (applicationStatusUnknown) {
        weeklyError.hidden = true;
        showApplyResult(
          { kind: 'unknown' },
          weeklyReadAgain,
        );
      } else {
        weeklyError.hidden = true;
        showApplyResult(
          { kind: 'error', conflict: stale },
          weeklyApply.hidden ? weeklyReadAgain : weeklyApply,
        );
      }
    } finally {
      actionPending = false;
      if (!applicationStatusUnknown)
        weeklyApply.disabled = Boolean(currentProposal?.application);
    }
  });
  weeklyReadAgain.addEventListener('click', async () => {
    if (actionPending || weeklyReadPending) return;
    weeklyReadPending = true;
    weeklyReadAgain.hidden = true;
    if (activeExecutionId) {
      const applyingUnknown = applicationStatusUnknown;
      if (applyingUnknown) {
        actionPending = true;
        try {
          const proposal = await fetchWeeklyProposal(activeExecutionId);
          applicationStatusUnknown = false;
          currentProposal = proposal;
          renderWeeklyProposal(proposal);
          if (proposal.application) {
            sessionStorage.removeItem('kinesis-weekly-request-key');
            showApplyResult(
              {
                kind: 'success',
                ignored: Number(proposal.application.ignored) || 0,
              },
              document.getElementById('aiCoachTitle'),
            );
          } else {
            weeklyApply.hidden = proposal.state !== 'completed' || proposal.outdated || !(proposal.proposal || proposal.response);
            weeklyCancel.hidden = !['queued', 'running'].includes(proposal.state);
            weeklyReadAgain.hidden = !['failed', 'uncertain'].includes(proposal.state);
            weeklyError.hidden = true;
            syncWeeklyActions();
            showApplyResult(
              { kind: 'error' },
              weeklyApply.hidden ? weeklyReadAgain : weeklyApply,
            );
          }
        } catch {
          applicationStatusUnknown = true;
          weeklyError.hidden = true;
          weeklyReadAgain.hidden = false;
          syncWeeklyActions();
          showApplyResult({ kind: 'unknown' }, weeklyReadAgain);
        } finally {
          actionPending = false;
          weeklyReadPending = false;
          weeklyApply.disabled = Boolean(currentProposal?.application);
        }
      } else {
        syncWeeklyActions();
        try {
          await refreshWeeklyExecution(activeExecutionId);
        } finally {
          weeklyReadPending = false;
          weeklyReadAgain.disabled = false;
        }
      }
      return;
    }
    const key = sessionStorage.getItem('kinesis-weekly-request-key');
    actionPending = true;
    weeklyReadAgain.disabled = true;
    try {
      const executions = await fetchAiExecutions();
      if (key && sessionStorage.getItem('kinesis-weekly-request-key') !== key)
        return;
      const found = key
        ? executions.find((entry) => entry.idempotency_key === key)
        : executions.find((entry) => entry.purpose === 'workouts');
      if (!found) {
        if (key) sessionStorage.removeItem('kinesis-weekly-request-key');
        weeklyHistoryState = 'ready';
        weeklyError.hidden = true;
        weeklySection.hidden = true;
        updateValidation();
        return;
      }
      activeExecutionId = found.id;
      sessionStorage.removeItem('kinesis-weekly-request-key');
      weeklyHistoryState = 'ready';
      updateValidation();
      void refreshWeeklyExecution(found.id);
    } catch {
      showWeeklyReadError();
    } finally {
      weeklyReadPending = false;
      actionPending = false;
      weeklyReadAgain.disabled = false;
    }
  });
  weeklyCancel.addEventListener('click', async () => {
    if (!activeExecutionId || actionPending) return;
    actionPending = true;
    readAttempt += 1;
    clearTimeout(pollTimer);
    pollTimer = null;
    weeklyCancel.disabled = true;
    try {
      await cancelAiExecution(activeExecutionId);
      await refreshWeeklyExecution(activeExecutionId);
    } catch {
      showWeeklyReadError();
    } finally {
      actionPending = false;
      weeklyCancel.disabled = false;
    }
  });
  if (isAdmin)
    externalPromptBtn.addEventListener(
      'click',
      () => void handleExternalPrompt(),
    );
  void recoverWeeklyExecution();

  targetDateInput.dataset.iso = dateInputValue(nextMonday());
  targetDateInput.value = targetDateInput.dataset.iso;
  const targetDatePicker = createDatePicker(targetDateDisplay, {
    isoInput: targetDateInput,
    getLanguage: () => i18n.language,
    getWeekStart: () => getUserPreferences().first_day_of_week,
    onChange: () => updateValidation(),
  });

  function readFormFields() {
    return Object.fromEntries(
      DAY_KEYS.map((day, index) => {
        const dbDay = DAY_DB_KEYS[index];
        const row = availabilityGrid.querySelector(`[data-day="${dbDay}"]`);
        const toggle = row?.querySelector('[data-can-train]');
        const selected = toggle?.checked;
        let legacyPeriods = [];
        try {
          legacyPeriods = JSON.parse(row?.dataset.legacyPeriods || '[]');
        } catch {
          legacyPeriods = [];
        }
        const selectedPeriods = selected
          ? [...(row?.querySelectorAll('[data-period]:checked') || [])].map(
              (input) => input.dataset.period,
            )
          : [];
        return [
          day,
          {
            // An unchecked control is an explicit unavailable choice in the UI.
            // Missing API rows are normalized to this presentation separately.
            can_train: Boolean(selected),
            available_periods: selected
              ? selectedPeriods.length
                ? selectedPeriods
                : legacyPeriods
              : [],
            legacy_periods:
              selected && selectedPeriods.length === 0 ? legacyPeriods : [],
            available_minutes:
              selected && row?.querySelector('[data-duration]')?.value
                ? Number(row.querySelector('[data-duration]').value)
                : null,
            location: selected
              ? row?.querySelector('[data-location]')?.value || ''
              : '',
          },
        ];
      }),
    );
  }

  function captureDailyFocus() {
    const active = document.activeElement;
    const row = active?.closest?.('.day-row');
    if (!row || !availabilityGrid.contains(active)) return null;

    let control = null;
    let selection = null;
    if (active.matches('[data-location]')) control = { type: 'location' };
    else if (active.matches('[data-duration]')) control = { type: 'duration' };
    else if (active.matches('[data-period]'))
      control = { type: 'period', period: active.dataset.period };
    else if (active.matches('[data-can-train]'))
      control = { type: 'can-train' };
    if (!control) return null;

    if (
      active instanceof HTMLInputElement &&
      active.type === 'text' &&
      typeof active.selectionStart === 'number' &&
      typeof active.selectionEnd === 'number'
    ) {
      selection = {
        start: active.selectionStart,
        end: active.selectionEnd,
        direction: active.selectionDirection,
      };
    }
    return {
      day: row.dataset.day,
      control,
      selection,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  }

  function restoreDailyFocus(snapshot) {
    if (!snapshot) return;
    const row = availabilityGrid.querySelector(`[data-day="${snapshot.day}"]`);
    if (!row) return;
    const { control } = snapshot;
    const target =
      control.type === 'location'
        ? row.querySelector('[data-location]')
        : control.type === 'duration'
          ? row.querySelector('[data-duration]')
          : control.type === 'period'
            ? [...row.querySelectorAll('[data-period]')].find(
                (input) => input.dataset.period === control.period,
              )
            : row.querySelector('[data-can-train]');
    if (!target) return;
    const details = target.closest('.day-details');
    if (details?.hidden && row.querySelector('[data-can-train]')?.checked) {
      details.hidden = false;
      row.querySelector('[data-expand]')?.setAttribute('aria-expanded', 'true');
    }
    if (
      target.disabled ||
      target.closest('[hidden]') ||
      target.getClientRects().length === 0
    )
      return;

    if (document.activeElement !== target) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
        window.scrollTo(snapshot.scrollX, snapshot.scrollY);
      }
    }
    if (
      snapshot.selection &&
      target instanceof HTMLInputElement &&
      target.type === 'text' &&
      typeof target.setSelectionRange === 'function'
    ) {
      try {
        target.setSelectionRange(
          snapshot.selection.start,
          snapshot.selection.end,
          snapshot.selection.direction,
        );
      } catch {
        // The control may not support text selection in this browser.
      }
    }
  }

  let lastDailyFocus = null;

  function setDayExpanded(row, expanded) {
    const details = row?.querySelector('.day-details');
    const expand = row?.querySelector('[data-expand]');
    if (!details || !expand) return;
    expand.setAttribute('aria-expanded', String(expanded));
    row
      .querySelector('.day-summary')
      ?.classList.toggle('is-expanded', expanded);
    details.hidden = !expanded;
  }

  function updateDayLocationSummary(row, location) {
    const summary = row?.querySelector('[data-day-location-summary]');
    if (!summary) return;
    summary.replaceChildren();
    if (!location) {
      summary.hidden = true;
      return;
    }
    const icon = document.createElement('i');
    icon.dataset.lucide = 'map-pin';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = location;
    summary.append(icon, text);
    summary.hidden = false;
    if (
      globalThis.lucide &&
      typeof globalThis.lucide.createIcons === 'function'
    )
      globalThis.lucide.createIcons();
  }

  function renderDayRows(
    states = readFormFields(),
    { preserveDays = [], focusSnapshot } = {},
  ) {
    const messages = i18n.messages.aiCoach;
    const days = orderedDayKeys(getUserPreferences().first_day_of_week);
    const focused =
      focusSnapshot === undefined ? captureDailyFocus() : focusSnapshot;
    const expandedDays = new Set(
      [...availabilityGrid.querySelectorAll('.day-row')]
        .filter(
          (row) =>
            row
              .querySelector('[data-expand]')
              ?.getAttribute('aria-expanded') === 'true',
        )
        .map((row) => DAY_KEYS[DAY_DB_KEYS.indexOf(row.dataset.day)]),
    );
    if (focused?.day)
      expandedDays.add(DAY_KEYS[DAY_DB_KEYS.indexOf(focused.day)]);
    const currentRows = [...availabilityGrid.querySelectorAll('.day-row')];
    const currentOrder = currentRows.map(
      (row) => DAY_KEYS[DAY_DB_KEYS.indexOf(row.dataset.day)],
    );
    const canPreserveRows =
      currentRows.length === days.length &&
      currentOrder.every((day, index) => day === days[index]);
    if (canPreserveRows) {
      for (let index = 0; index < days.length; index += 1) {
        const day = days[index];
        if (preserveDays.includes(day)) continue;
        const row = currentRows[index];
        const template = document.createElement('template');
        template.innerHTML = buildDayRowHtml(day, {
          dayLabel: t(`aiCoach.days.${DAY_LOCALE_KEYS[day]}`),
          messages,
          state: { ...(states[day] || {}), expanded: expandedDays.has(day) },
        });
        row.replaceWith(template.content.firstElementChild);
      }
    } else {
      availabilityGrid.innerHTML = days
        .map((day) =>
          buildDayRowHtml(day, {
            dayLabel: t(`aiCoach.days.${DAY_LOCALE_KEYS[day]}`),
            messages,
            state: { ...(states[day] || {}), expanded: expandedDays.has(day) },
          }),
        )
        .join('');
    }
    availabilityGrid.querySelectorAll('.day-row').forEach((row) => {
      const selected = row.querySelector('[data-can-train]')?.checked;
      const details = row.querySelector('.day-details');
      const focusedInside =
        row.contains(document.activeElement) &&
        details.contains(document.activeElement);
      if (focusedInside)
        row
          .querySelector('[data-expand]')
          ?.setAttribute('aria-expanded', 'true');
      const expanded =
        focusedInside ||
        row.querySelector('[data-expand]')?.getAttribute('aria-expanded') ===
          'true';
      setDayExpanded(row, expanded);
      details.querySelectorAll('input, select').forEach((input) => {
        input.disabled = !selected;
      });
      row.dataset.configured =
        row.querySelector('[data-can-train]')?.dataset.configured === 'true' ||
        selected
          ? 'true'
          : row.dataset.configured || 'false';
    });
    if (
      globalThis.lucide &&
      typeof globalThis.lucide.createIcons === 'function'
    )
      globalThis.lucide.createIcons();
    restoreDailyFocus(focused);
    if (focused)
      requestAnimationFrame(() => {
        if (
          document.activeElement === document.body ||
          !availabilityGrid.contains(document.activeElement)
        )
          restoreDailyFocus(focused);
      });
  }

  let availabilityRevision = 0;
  let lastAvailabilitySnapshot = '';
  let lastLoadedAvailabilitySnapshot = '';
  let availabilityLoadState = 'pending';
  let availabilityLoadAttempt = 0;

  function currentAvailabilitySnapshot() {
    return JSON.stringify(readFormFields());
  }

  function daysEditedSince(snapshot) {
    const before = JSON.parse(snapshot);
    const current = readFormFields();
    return DAY_KEYS.filter(
      (day) => JSON.stringify(before[day]) !== JSON.stringify(current[day]),
    );
  }

  function applyAvailabilityState(week, { preserveDays = [] } = {}) {
    const states = availabilityDefaults();
    for (const record of week.days || []) {
      const day = DAY_KEYS[DAY_DB_KEYS.indexOf(record.day)];
      // Keep null in the API so needsReview remains meaningful, but show a
      // missing row as the same unchecked/unavailable initial state.
      if (day && record?.can_train !== null && record?.can_train !== undefined)
        states[day] = record;
    }
    const current = readFormFields();
    for (const day of preserveDays) states[day] = current[day];
    renderDayRows(states, { preserveDays });
    lastAvailabilitySnapshot = currentAvailabilitySnapshot();
    lastLoadedAvailabilitySnapshot = lastAvailabilitySnapshot;
    availabilityReview.hidden = !week.needsReview;
    availabilityReview.textContent = t('aiCoach.availabilityReview');
  }

  function setAvailabilityLoadState(state) {
    availabilityLoadState = state;
    const pending = state === 'pending';
    const failed = state === 'error';
    saveAvailabilityButton.disabled = state !== 'ready';
    saveAvailabilityButton.setAttribute(
      'aria-disabled',
      String(state !== 'ready'),
    );
    availabilityRetry.hidden = !failed;
    availabilityRetry.textContent = failed
      ? t('aiCoach.availabilityRetry')
      : '';
    if (pending) setAvailabilityStatus('availabilityLoading');
    else if (failed) setAvailabilityStatus('');
    else if (availabilityStatusKey === 'availabilityLoading')
      setAvailabilityStatus('');
    updateValidation();
  }

  let availabilityStatusKey = '';
  function setAvailabilityStatus(key) {
    availabilityStatusKey = key;
    availabilityStatus.textContent = key ? t(`aiCoach.${key}`) : '';
    availabilityStatus.classList.toggle(
      'is-success',
      key === 'availabilitySaved',
    );
    availabilityStatus.classList.toggle(
      'is-error',
      Boolean(key) && key !== 'availabilitySaved',
    );
  }

  function noteAvailabilityEdit() {
    const snapshot = currentAvailabilitySnapshot();
    if (snapshot === lastAvailabilitySnapshot) return false;
    lastAvailabilitySnapshot = snapshot;
    availabilityRevision += 1;
    setAvailabilityStatus('');
    return true;
  }

  async function loadAvailability() {
    const attempt = ++availabilityLoadAttempt;
    const requestedSnapshot = lastLoadedAvailabilitySnapshot;
    setAvailabilityLoadState('pending');
    try {
      const saved = await fetchAiCoachAvailability();
      if (attempt !== availabilityLoadAttempt) return false;
      // Compare against the last successfully loaded snapshot directly. This
      // also preserves edits made after a failed load and before a retry.
      const preserveDays = daysEditedSince(requestedSnapshot);
      applyAvailabilityState(saved, { preserveDays });
      setAvailabilityLoadState('ready');
      setAvailabilityStatus('');
      return true;
    } catch {
      if (attempt !== availabilityLoadAttempt) return false;
      setAvailabilityLoadState('error');
      availabilityError.textContent = t('aiCoach.availabilityLoadError');
      return false;
    }
  }

  async function persistAvailability() {
    if (availabilityLoadState !== 'ready') return false;
    const submittedRevision = availabilityRevision;
    const submittedSnapshot = currentAvailabilitySnapshot();
    const fields = readFormFields();
    const validation = validatePromptFields({
      targetDate: readTargetDateIso(
        targetDateInput,
        targetDatePicker,
        i18n.language,
      ),
      language: i18n.language,
      disponibilidade: fields,
    });
    if (validation.missing.includes('availability')) {
      availabilityError.textContent = t('aiCoach.availabilityValidation');
      return false;
    }
    const days = DAY_KEYS.map((day, index) => ({
      day: DAY_DB_KEYS[index],
      can_train: fields[day].can_train,
      available_periods: fields[day].available_periods,
      available_minutes: fields[day].available_minutes,
      location: fields[day].location,
    }));
    try {
      const saved = await saveAiCoachAvailability(days);
      const preserveDays =
        availabilityRevision === submittedRevision
          ? []
          : daysEditedSince(submittedSnapshot);
      const unchanged = preserveDays.length === 0;
      const active = document.activeElement;
      const captured = captureDailyFocus();
      const focused =
        captured ||
        (preserveDays.length &&
        (active === document.body || active === saveAvailabilityButton)
          ? lastDailyFocus
          : null);
      applyAvailabilityState(saved, { preserveDays });
      if (focused) requestAnimationFrame(() => restoreDailyFocus(focused));
      availabilityError.textContent = '';
      setAvailabilityStatus(
        unchanged ? 'availabilitySaved' : 'availabilityEditedDuringSave',
      );
      if (!unchanged) updateValidation();
      return unchanged;
    } catch {
      setAvailabilityStatus('availabilitySaveError');
      return false;
    }
  }

  renderDayRows();
  lastAvailabilitySnapshot = currentAvailabilitySnapshot();
  lastLoadedAvailabilitySnapshot = lastAvailabilitySnapshot;
  void loadAvailability();

  function updateValidation() {
    const disponibilidade = readFormFields();
    const validation = validatePromptFields({
      targetDate: readTargetDateIso(
        targetDateInput,
        targetDatePicker,
        i18n.language,
      ),
      language: i18n.language,
      disponibilidade,
    });
    const availabilityReady = availabilityLoadState === 'ready';
    generateBtn.disabled =
      !availabilityReady ||
      weeklyHistoryState !== 'ready' ||
      weeklyReadUnavailable ||
      !validation.valid;
    generateBtn.setAttribute(
      'aria-disabled',
      String(
        !availabilityReady ||
          weeklyHistoryState !== 'ready' ||
          weeklyReadUnavailable ||
          !validation.valid,
      ),
    );
    const hasPendingLegacy = Object.values(disponibilidade).some(
      (record) => record.can_train === true && record.legacy_periods.length > 1,
    );
    saveAvailabilityButton.disabled = !availabilityReady || hasPendingLegacy;
    saveAvailabilityButton.setAttribute(
      'aria-disabled',
      String(!availabilityReady || hasPendingLegacy),
    );
    targetDateInput.setAttribute(
      'aria-invalid',
      String(validation.missing.includes('targetDate')),
    );
    availabilityGrid.setAttribute(
      'aria-invalid',
      String(validation.missing.includes('availability')),
    );
    availabilityGrid.setAttribute('aria-describedby', availabilityError.id);
    availabilityError.textContent =
      availabilityLoadState === 'error'
        ? t('aiCoach.availabilityLoadError')
        : validation.missing.includes('availability') && availabilityReady
          ? t('aiCoach.availabilityValidation')
          : '';
    availabilityGrid.querySelectorAll('.day-row').forEach((row) => {
      const dayIndex = DAY_DB_KEYS.indexOf(row.dataset.day);
      const day = DAY_KEYS[dayIndex];
      const unset = disponibilidade[day].can_train === null;
      const toggle = row.querySelector('[data-can-train]');
      toggle?.setAttribute('aria-invalid', String(unset));
      toggle?.setAttribute('aria-describedby', availabilityError.id);
    });
    for (const [day, dayIndex] of DAY_KEYS.map((day, index) => [day, index])) {
      const record = disponibilidade[day];
      const row = availabilityGrid.querySelector(
        `[data-day="${DAY_DB_KEYS[dayIndex]}"]`,
      );
      if (!row) continue;
      const summary = daySummary(record, i18n.messages.aiCoach);
      const summaryText = row.querySelector('[data-day-summary]');
      if (summaryText) summaryText.textContent = summary.text;
      updateDayLocationSummary(
        row,
        record.can_train === true ? String(record.location || '') : '',
      );
      const incomplete = row.querySelector('[data-day-incomplete]');
      if (summary.incomplete && !incomplete) {
        const marker = document.createElement('span');
        marker.className = 'day-incomplete';
        marker.dataset.dayIncomplete = '';
        marker.textContent = t('aiCoach.dayIncomplete');
        row.querySelector('.day-summary-copy')?.append(marker);
      } else if (!summary.incomplete && incomplete) incomplete.remove();
      if (record.can_train !== true) {
        const error = row.querySelector('[data-day-error]');
        error.hidden = true;
        error.replaceChildren();
        continue;
      }
      const periods = row.querySelector('.period-group');
      const duration = row.querySelector('[data-duration]');
      const location = row.querySelector('[data-location]');
      const dayErrorKeys = validateAvailabilityDay(record).filter(
        (key) => key !== 'availability',
      );
      const errors = dayErrorKeys.map((key) => t(`aiCoach.${key}`));
      const error = row.querySelector('[data-day-error]');
      error.replaceChildren(
        ...errors.map((message) => {
          const item = document.createElement('li');
          item.textContent = message;
          return item;
        }),
      );
      error.hidden = errors.length === 0;
      const errorId = error.id;
      const periodError =
        dayErrorKeys.includes('availabilityNeedsPeriods') ||
        dayErrorKeys.includes('availabilityNeedsSinglePeriod');
      periods.setAttribute('aria-invalid', String(periodError));
      if (dayErrorKeys.length)
        periods.setAttribute('aria-describedby', errorId);
      else periods.removeAttribute('aria-describedby');
      periods.querySelectorAll('input').forEach((input) => {
        input.setAttribute('aria-invalid', String(periodError));
        if (dayErrorKeys.length)
          input.setAttribute('aria-describedby', errorId);
        else input.removeAttribute('aria-describedby');
      });
      duration.setAttribute(
        'aria-invalid',
        String(dayErrorKeys.includes('availabilityNeedsDuration')),
      );
      const durationDescribedBy = [
        duration.dataset.hintId,
        dayErrorKeys.length ? errorId : '',
      ]
        .filter(Boolean)
        .join(' ');
      if (durationDescribedBy)
        duration.setAttribute('aria-describedby', durationDescribedBy);
      else duration.removeAttribute('aria-describedby');
      location.setAttribute(
        'aria-invalid',
        String(
          dayErrorKeys.includes('availabilityNeedsLocation') ||
            dayErrorKeys.includes('availabilityLocationTooLong'),
        ),
      );
      if (dayErrorKeys.length)
        location.setAttribute('aria-describedby', errorId);
      else location.removeAttribute('aria-describedby');
    }
    return validation;
  }

  updateValidation();

  availabilityGrid.addEventListener('focusin', () => {
    const focused = captureDailyFocus();
    if (focused) lastDailyFocus = focused;
  });

  document.addEventListener('kinesis:preferences-changed', (event) => {
    const next = event.detail?.first_day_of_week;
    if (next === 'Monday' || next === 'Sunday') renderDayRows();
  });

  // A base location is an explicit user supplied convenience, copied into
  // available day inputs. Each day remains independent afterwards.
  baseLocationInput.addEventListener('change', () => {
    availabilityGrid.querySelectorAll('[data-location]').forEach((input) => {
      if (!input.disabled && !input.value.trim())
        input.value = baseLocationInput.value;
    });
    updateValidation();
  });
  availabilityGrid.addEventListener('change', (event) => {
    const row = event.target.closest('.day-row');
    if (row && event.target.matches('[data-can-train]')) {
      row.dataset.configured = 'true';
      const details = row.querySelector('.day-details');
      const available = event.target.checked;
      const expand = row.querySelector('[data-expand]');
      if (expand) {
        expand.setAttribute('aria-expanded', String(available));
        expand.setAttribute(
          'aria-label',
          `${t(available ? 'aiCoach.dayCollapse' : 'aiCoach.dayExpand')} ${row.querySelector('.day-label')?.textContent || ''}`.trim(),
        );
      }
      if (
        !available &&
        document.activeElement &&
        details.contains(document.activeElement)
      )
        row.querySelector('[data-can-train]')?.focus();
      setDayExpanded(row, available);
      details.querySelectorAll('input, select').forEach((input) => {
        input.disabled = !available;
      });
      if (available) {
        const location = row.querySelector('[data-location]');
        if (location && !location.value.trim())
          location.value = baseLocationInput.value;
      } else {
        details.querySelectorAll('[data-period]').forEach((input) => {
          input.checked = false;
        });
        row.querySelector('[data-duration]').value = '';
        row.querySelector('[data-location]').value = '';
        row.dataset.legacyPeriods = '[]';
        row.querySelector('[data-legacy-period-summary]')?.remove();
      }
    }
    if (
      row &&
      event.target.matches('[data-period], [data-duration], [data-location]')
    ) {
      row.dataset.configured = 'true';
      if (event.target.matches('[data-period]')) {
        row.dataset.legacyPeriods = '[]';
        row.querySelector('[data-legacy-period-summary]')?.remove();
      }
    }
    noteAvailabilityEdit();
    updateValidation();
  });
  availabilityGrid.addEventListener('input', () => {
    noteAvailabilityEdit();
    updateValidation();
  });
  availabilityGrid.addEventListener('click', (event) => {
    const expand = event.target.closest('[data-expand]');
    if (expand) {
      const row = expand.closest('.day-row');
      if (!row) return;
      const details = row.querySelector('.day-details');
      const expanded = expand.getAttribute('aria-expanded') === 'true';
      if (expanded && details.contains(document.activeElement))
        row.querySelector('[data-expand]')?.focus({ preventScroll: true });
      setDayExpanded(row, !expanded);
      expand.setAttribute(
        'aria-label',
        `${t(expanded ? 'aiCoach.dayExpand' : 'aiCoach.dayCollapse')} ${row.querySelector('.day-label')?.textContent || ''}`.trim(),
      );
      return;
    }
    if (!event.target.closest('#applyWeekdays')) return;
    const states = readFormFields();
    const monday = states.segunda;
    if (monday.can_train === null) {
      setAvailabilityStatus('availabilityNoMonday');
      return;
    }
    for (const day of ['terca', 'quarta', 'quinta', 'sexta'])
      states[day] = structuredClone(monday);
    renderDayRows(states);
    noteAvailabilityEdit();
    updateValidation();
  });
  saveAvailabilityButton.addEventListener('click', () => {
    void persistAvailability();
  });
  availabilityRetry.addEventListener('click', () => {
    void loadAvailability();
  });

  document.addEventListener('app:languagechange', () => {
    const focusSnapshot = lastDailyFocus;
    renderDayRows(readFormFields(), { focusSnapshot });
    if (focusSnapshot)
      requestAnimationFrame(() => restoreDailyFocus(focusSnapshot));
    saveAvailabilityLabel.textContent = t('aiCoach.saveAvailability');
    availabilityReview.textContent = t('aiCoach.availabilityReview');
    availabilityRetry.textContent =
      availabilityLoadState === 'error' ? t('aiCoach.availabilityRetry') : '';
    if (availabilityStatusKey) setAvailabilityStatus(availabilityStatusKey);
    const targetIso = readTargetDateIso(
      targetDateInput,
      targetDatePicker,
      i18n.language,
    );
    targetDateInput.dataset.iso = targetIso;
    targetDateInput.value = targetIso;
    targetDatePicker.refresh();
    updateValidation();
    if (currentProposal) renderWeeklyProposal(currentProposal);
    if (applyResult) applyResultCopy();
  });

  saveAvailabilityLabel.textContent = t('aiCoach.saveAvailability');

  async function handleCopy() {
    const copied = await copyPromptText(promptOutput.textContent);
    if (promptModal.hidden) return;
    promptCopyStatus.textContent = copied
      ? t('aiCoach.promptCopied')
      : t('aiCoach.promptCopyFailed');
    copyIcon.setAttribute('data-lucide', copied ? 'check' : 'copy');
    refreshIcons();
    clearTimeout(promptCopiedTimer);
    if (copied)
      promptCopiedTimer = setTimeout(() => {
        if (!promptModal.hidden) promptCopyStatus.textContent = '';
        copyIcon.setAttribute('data-lucide', 'copy');
        refreshIcons();
      }, COPY_FEEDBACK_MS);
  }

  form.addEventListener('submit', handleGenerate);
  if (isAdmin) {
    promptClose.addEventListener('click', closeExternalPrompt);
    promptCloseAction.addEventListener('click', closeExternalPrompt);
    promptModal.addEventListener('click', (event) => {
      if (event.target === promptModal) closeExternalPrompt();
    });
    copyBtn.addEventListener('click', () => void handleCopy());
  }
  applyResultClose.addEventListener('click', closeApplyResult);
  applyResultOk.addEventListener('click', closeApplyResult);
  applyResultModal.addEventListener('click', (event) => {
    if (event.target === applyResultModal) closeApplyResult();
  });
}

export async function initAiCoach() {
  const user = await initShell({ active: 'ai-coach' });
  if (!user) return null;
  setupAiCoachPage(user);
  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initAiCoach().catch(() => window.location.replace('/login.html'));
}
