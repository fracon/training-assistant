import {
  initShell,
  getShellI18n,
  getUserPreferences,
  showShellToast,
} from './shared/shell.js';
import { requestJson } from './shared/api.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { createDatePicker } from './shared/datepicker.js';
import { formatDistance, formatPaceFromMetric } from './shared/units.js';
import { BREATHING_LABEL_KEYS, MUSCLE_LABEL_KEYS, ENERGY_LABEL_KEYS } from './shared/analysis-prompts.js';
import { copyPromptText, DAY_DB_KEYS } from './shared/workout-prompts.js';

async function initMemory() {
  const user = await initShell();
  if (!user) return;
  const $ = (id) => document.getElementById(id);
  const i18n = getShellI18n();
  const t = (key) => translate(i18n.messages, `memory.${key}`);
  const fields = ['experience'];
  const previewPicker =
    user.role === 'admin'
      ? createDatePicker($('previewDate'), { getLanguage: () => i18n.language })
      : null;
  const dirty = new Set();
  for (const field of fields)
    $(field).addEventListener('input', () => dirty.add(field));
  let memory = null;
  let busy = false;
  let resources = null;
  let loaded = false;
  let errorKey = null;
  const debugLabels = [];
  let refreshResources = () => {};
  if (user.role !== 'admin') $('memoryDebug').remove();
  else $('memoryDebug').hidden = false;
  function controls() {
    $('profileForm').querySelector('[type=submit]').disabled = !loaded || busy;
    $('reloadMemory').disabled = busy;
    if (user.role === 'admin')
      $('previewForm').querySelector('[type=submit]').disabled =
        !resources || busy;
  }
  function error(error, focus = true) {
    const code = error?.codes?.[0];
    errorKey =
      code && t(`errors.${code}`) !== `memory.errors.${code}`
        ? `errors.${code}`
        : 'errors.generic';
    $('memoryStatus').textContent = '';
    const message = t(errorKey);
    $('memoryError').textContent = message;
    $('memoryError').classList.remove('hidden');
    if (focus) $('memoryError').focus();
  }
  function clearError() {
    errorKey = null;
    $('memoryError').classList.add('hidden');
    for (const input of document.querySelectorAll('[aria-invalid]')) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }
  function renderOverview() {
    const root = $('memoryOverview');
    const focusedKey = root.contains(document.activeElement) ? document.activeElement.dataset.memoryLink : null;
    const opened = new Set([...root.querySelectorAll('details[open]')].map((element) => element.dataset.memoryDisclosure));
    root.replaceChildren();
    const date = (value) => value ? formatDate(value.slice(0, 10), i18n.language) : t('unknown');
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text != null) element.textContent = text;
      return element;
    };
    const paragraph = (parent, value, hint = false) => parent.append(node('p', hint ? 'field-hint' : '', value));
    const link = (parent, href, label, key) => {
      const a = node('a', 'memory-source', label);
      a.dataset.memoryLink = key; a.href = href; parent.append(a);
    };
    const top = node('div', 'memory-summary-grid'); root.append(top);
    const section = (key, origin, href, parent = root) => {
      const card = node('section', 'shoe-card memory-section memory-entry');
      const header = node('header', 'memory-card-header');
      const h = node('h2', '', t(key)); h.id = `memory-${key}`;
      card.setAttribute('aria-labelledby', h.id);
      header.append(h);
      const action = key === 'cycle' ? 'editCycle' : key === 'availability' ? 'editAvailability' : 'openCalendar';
      link(header, href, t(action), key);
      card.append(header); paragraph(card, t(origin), true);
      parent.append(card); return card;
    };
    const metric = (parent, label, value) => {
      const item = node('div', 'memory-metric');
      item.append(node('dt', '', label), node('dd', '', value)); parent.append(item);
    };
    const table = (parent, caption, headings) => {
      const wrap = node('div', 'memory-table-wrap');
      wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', caption);
      wrap.dataset.memoryLink = `table:${parent.getAttribute('aria-labelledby')}`;
      const table = node('table', 'memory-table');
      table.append(node('caption', 'visually-hidden', caption));
      const head = node('thead'); const row = node('tr');
      for (const heading of headings) { const cell = node('th', '', heading); cell.scope = 'col'; row.append(cell); }
      head.append(row); const body = node('tbody'); table.append(head, body); wrap.append(table); parent.append(wrap);
      return body;
    };
    const cycle = section('cycle', 'cycleOrigin', '/cycles.html', top);
    if (memory.cycle) {
      paragraph(cycle, memory.cycle.objective);
      const goals = node('dl', 'memory-facts'); cycle.append(goals);
      for (const [key, value] of [['primaryGoal', memory.cycle.primaryGoal], ['secondaryGoal', memory.cycle.secondaryGoal], ['otherEvents', memory.cycle.otherEvents]])
        if (value) metric(goals, translate(i18n.messages, `cycles.${key}`), value);
      if (memory.cycle.status) metric(goals, t('status'), translate(i18n.messages, `cycles.status.${memory.cycle.status}`));
      metric(goals, t('period'), `${date(memory.cycle.startDate)} → ${date(memory.cycle.targetDate)}`);
      paragraph(cycle, `${t('updated')}: ${date(memory.cycle.updatedAt)}`, true);
    } else paragraph(cycle, t('cycleEmpty'));
    const availability = section('availability', 'availabilityOrigin', '/ai-coach.html', top);
    if (!memory.availability.length) paragraph(availability, t('availabilityEmpty'));
    else {
      if (memory.availability.length < 7) paragraph(availability, t('availabilityIncomplete'), true);
      const days = getUserPreferences().first_day_of_week === 'Sunday' ? [DAY_DB_KEYS[6], ...DAY_DB_KEYS.slice(0, 6)] : DAY_DB_KEYS;
      const rows = [...memory.availability].sort((a, b) => days.indexOf(a.day) - days.indexOf(b.day));
      const sameUpdate = new Set(rows.map((row) => row.updatedAt)).size === 1;
      const body = table(availability, t('availability'), ['day', 'time', 'maximum', 'location'].map(t));
      for (const row of rows) {
        const tr = node('tr'); tr.dataset.day = row.day;
        const day = node('th', '', translate(i18n.messages, `aiCoach.days.${row.day}`)); day.scope = 'row'; tr.append(day);
        const periods = row.periods.map((period) => translate(i18n.messages, `aiCoach.periods.${period}`)).join(', ');
        tr.append(node('td', '', row.canTrain ? periods || t('unknown') : t('unavailable')),
          node('td', '', row.canTrain ? row.minutes == null ? t('unknown') : `${row.minutes} ${t('minutes')}` : '—'),
          node('td', '', row.canTrain ? row.location || t('unknown') : '—'));
        if (row.periods.length > 1) day.append(node('span', 'field-hint memory-row-note', t('availabilityReview')));
        if (!sameUpdate) day.append(node('span', 'field-hint memory-row-note', `${t('updated')}: ${date(row.updatedAt)}`));
        body.append(tr);
      }
      paragraph(availability, t('durationHint'), true);
      if (sameUpdate) paragraph(availability, `${t('updated')}: ${date(rows[0].updatedAt)}`, true);
    }
    for (const [key, rows] of [['recent', memory.recent], ['upcoming', memory.upcoming], ['comparables', memory.comparables]]) {
      const card = section(key, 'sessionOrigin', '/calendar.html');
      if (key !== 'comparables') paragraph(card, key === 'recent'
        ? `${date(memory.ranges.detailedFrom)} → ${date(memory.asOf)}`
        : `${date(memory.asOf)} → ${date(memory.ranges.plannedTo)}`, true);
      if (!rows.length) { card.classList.add('memory-empty'); paragraph(card, t('sessionsEmpty')); }
      for (const row of rows) {
        const article = node('article', 'memory-session');
        const title = node('h3', '', `${date(row.date)} · ${row.planned.treino || row.planned.tipo || t('unknown')}`);
        article.append(title);
        paragraph(article, row.actual.completed ? t('completed') : t('planned'), true);
        const actual = row.actual;
        const metrics = node('dl', 'memory-metrics');
        if (actual.fit_distance != null) metric(metrics, t('distance'), formatDistance(actual.fit_distance, getUserPreferences().distance_unit));
        if (actual.fit_duration) metric(metrics, t('duration'), actual.fit_duration);
        if (actual.fit_avg_pace) metric(metrics, t('pace'), formatPaceFromMetric(actual.fit_avg_pace, getUserPreferences().distance_unit));
        for (const [field, label, unit] of [['fit_avg_hr', 'session.manualAvgHr', 'bpm'], ['fit_max_hr', 'session.manualMaxHr', 'bpm'], ['fit_elevation_gain', 'session.manualElevation', 'm'], ['fit_calories', 'session.resultCalories', 'kcal']])
          if (actual[field] != null) metric(metrics, translate(i18n.messages, label), `${actual[field]} ${unit}`);
        if (metrics.childElementCount) article.append(metrics);
        const report = row.report;
        const feedback = node('div', 'memory-feedback');
        for (const field of ['feedback_rpe', 'feedback_notas', 'feedback_breathing', 'feedback_muscle', 'feedback_energy', 'feedback_pain'])
          if (report[field] != null && report[field] !== '') {
            const labels = { feedback_breathing: BREATHING_LABEL_KEYS, feedback_muscle: MUSCLE_LABEL_KEYS, feedback_energy: ENERGY_LABEL_KEYS };
            const labelKey = labels[field]?.[report[field]];
            const value = labelKey ? translate(i18n.messages, labelKey) : report[field];
            paragraph(feedback, `${t(`feedback.${field}`)}: ${value}`);
          }
        if (report.feedback_has_pain === 'yes' || report.feedback_has_pain === 'no')
          paragraph(feedback, `${t('feedback.feedback_has_pain')}: ${t(report.feedback_has_pain)}`);
        if (feedback.childElementCount) {
          feedback.prepend(node('p', 'field-hint', `${t('reportedOn')}: ${date(row.report.observedOn || row.date)}`));
          article.append(feedback);
        }
        if (row.planned.detalhes) {
          const details = node('details', 'memory-planning');
          const detailKey = `details:${key}:${row.href}`;
          details.dataset.memoryDisclosure = detailKey;
          details.open = opened.has(detailKey);
          const summary = node('summary', '', t('planningDetails')); summary.dataset.memoryLink = detailKey;
          details.append(summary, node('p', '', row.planned.detalhes)); article.append(details);
        }
        if (row.includedInAggregates) paragraph(article, t('includedInAggregates'), true);
        link(article, row.href, t('openSession'), `${key}:${row.href}`); card.append(article);
      }
    }
    const weekly = section('weekly', 'weeklyOrigin', '/calendar.html');
    paragraph(weekly, `${date(memory.ranges.aggregateFrom)} → ${date(memory.ranges.aggregateTo)}`, true);
    if (!memory.weekly.length) { weekly.classList.add('memory-empty'); paragraph(weekly, t('aggregatesEmpty')); }
    else {
      weekly.append(node('p', 'field-hint memory-scroll-hint', t('tableHint')));
      const body = table(weekly, t('weekly'), ['week', 'sessions', 'distance', 'duration', 'effort', 'missingResults'].map(t));
      for (const row of memory.weekly) {
        const tr = node('tr'); const heading = node('th', '', date(row.weekStart)); heading.scope = 'row'; tr.append(heading);
        for (const value of [`${row.completed}/${row.planned}`, formatDistance(row.distanceKm, getUserPreferences().distance_unit), `${Math.round(row.durationSeconds / 60)} ${t('minutes')}`, row.averageRpe === null ? t('unknown') : row.averageRpe.toFixed(1), row.missingResults]) tr.append(node('td', '', value));
        body.append(tr);
      }
      paragraph(weekly, t('totalsHint'), true);
    }
    $('selectionNotice').hidden = !memory.selectionLimited;
    $('legacyNotice').hidden = !memory.legacyAvailable;
    const updated = memory.profile.fields.experience?.updatedAt;
    $('profileSource').textContent = updated
      ? `${t('authorities.user_report')} · ${t('updated')}: ${date(updated)}`
      : t('profileEmpty');
    $('memoryStatus').textContent = `${t('asOf')}: ${date(memory.asOf)}`;
    if (focusedKey) [...root.querySelectorAll('[data-memory-link]')].find((a) => a.dataset.memoryLink === focusedKey)?.focus();
    controls();
  }
  async function mutate(action) {
    if (busy) return;
    busy = true;
    controls();
    clearError();
    try {
      await action();
      showShellToast(i18n.messages, 'memory.saved');
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      controls();
    }
  }
  async function load() {
    if (busy) return;
    busy = true;
    controls();
    clearError();
    $('memoryStatus').textContent = t('loading');
    try {
      memory = await requestJson('/api/ai/memory', undefined, 'GET');
      loaded = true;
      for (const field of fields)
          if (!dirty.has(field))
            $(field).value = memory.profile.fields[field]?.value || '';
      renderOverview();
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      controls();
    }
  }
  $('reloadMemory').addEventListener('click', () => load());
  $('profileForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!loaded) return;
    mutate(async () => {
      const submitted = $('experience').value;
      const saved = await requestJson(
        '/api/ai/profile',
        {
          fields: { experience: submitted },
          expected_version: memory.profile.version,
        },
        'PUT',
      );
      memory.profile = saved.profile;
      if ($('experience').value === submitted) dirty.delete('experience');
      renderOverview();
    });
  });
  if (user.role === 'admin') {
    function renderResources() {
      const purpose = $('previewPurpose').value;
      const selected = $('previewResource').value;
      $('previewResource').replaceChildren();
      for (const row of purpose === 'analysis'
        ? resources.trainings
        : resources.cycles) {
        const option = document.createElement('option');
        option.value = row.id;
        option.textContent =
          purpose === 'analysis'
            ? `${formatDate(row.dia, i18n.language)} · ${row.treino || row.tipo}`
            : row.objective;
        $('previewResource').append(option);
      }
      if (
        [...$('previewResource').options].some(
          (option) => option.value === selected,
        )
      )
        $('previewResource').value = selected;
      $('previewResource').disabled = purpose === 'workouts';
      $('previewDate').closest('.field').hidden = purpose !== 'workouts';
    }
    refreshResources = () => {
      if (resources) renderResources();
    };
    $('previewPurpose').addEventListener('change', () => {
      if (resources) renderResources();
    });
    $('previewForm').addEventListener('submit', (event) => {
      event.preventDefault();
      mutate(async () => {
        const purpose = $('previewPurpose').value;
        const result = await requestJson('/api/ai/admin/preview', {
          purpose,
          ...(purpose === 'workouts'
            ? { target_date: previewPicker.getValue() }
            : { resource_id: $('previewResource').value }),
        });
        $('promptPreview').value = result.prompt;
        $('contextPreview').value = JSON.stringify(result.context, null, 2);
        $('copyPrompt').disabled = false;
      });
    });
    $('copyPrompt').addEventListener('click', async () => {
      if (await copyPromptText($('promptPreview').value))
        showShellToast(i18n.messages, 'memory.copied');
      else error(new Error());
    });
    try {
      const [cycles, trainings, usage, executions] = await Promise.all([
        requestJson('/api/cycles', undefined, 'GET'),
        requestJson('/api/calendar/trainings', undefined, 'GET'),
        requestJson('/api/ai/admin/usage', undefined, 'GET'),
        requestJson('/api/ai/executions', undefined, 'GET'),
      ]);
      resources = { cycles: cycles.cycles, trainings: trainings.trainings };
      renderResources();
      const usageLabel = () => {
        $('usageSummary').textContent =
          `${t('usage')}: ${usage.usage.reduce((sum, row) => sum + row.tokens, 0)} ${t('tokens')}`;
      };
      debugLabels.push(usageLabel);
      usageLabel();
      for (const execution of executions.executions) {
        const button = document.createElement('button');
        button.className = 'btn-secondary';
        button.type = 'button';
        const label = () => {
          button.textContent = `${t(`purposes.${execution.purpose}`)} · ${formatDate(execution.created_at.slice(0, 10), i18n.language)} · ${t(`executionStates.${execution.state}`)}`;
        };
        debugLabels.push(label);
        label();
        button.addEventListener('click', async () => {
          try {
            const result = await requestJson(
              `/api/ai/admin/executions/${encodeURIComponent(execution.id)}`,
              undefined,
              'GET',
            );
            $('contextPreview').value = JSON.stringify(result, null, 2);
          } catch (e) {
            error(e);
          }
        });
        $('executionList').append(button);
      }
    } catch (e) {
      error(e);
    }
    controls();
  }
  document.addEventListener('kinesis:preferences-changed', () => { if (memory) renderOverview(); });
  document.addEventListener('app:languagechange', () => {
    previewPicker?.refresh();
    if (memory) renderOverview();
    if (errorKey) $('memoryError').textContent = t(errorKey);
    refreshResources();
    debugLabels.forEach((update) => update());
  });
  await load();
}
if (typeof document !== 'undefined') initMemory();
