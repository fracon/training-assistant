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
import { copyPromptText } from './shared/workout-prompts.js';

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
    root.replaceChildren();
    const date = (value) => value ? formatDate(value.slice(0, 10), i18n.language) : t('unknown');
    const paragraph = (parent, value, hint = false) => {
      const p = document.createElement('p');
      p.textContent = value;
      if (hint) p.className = 'field-hint';
      parent.append(p);
    };
    const link = (parent, href, label, key) => {
      const a = document.createElement('a'); a.className = 'btn-secondary'; a.dataset.memoryLink = key; a.href = href; a.textContent = label; parent.append(a);
    };
    const section = (key, origin, href) => {
      const card = document.createElement('section'); card.className = 'shoe-card memory-section memory-entry';
      const h = document.createElement('h2'); h.textContent = t(key); card.append(h);
      paragraph(card, t(origin), true);
      link(card, href, t('correctSource'), key);
      root.append(card); return card;
    };
    const cycle = section('cycle', 'cycleOrigin', '/cycles.html');
    if (memory.cycle) {
      for (const [key, value] of [['objective', memory.cycle.objective], ['primaryGoal', memory.cycle.primaryGoal], ['secondaryGoal', memory.cycle.secondaryGoal], ['otherEvents', memory.cycle.otherEvents]])
        if (value) paragraph(cycle, `${translate(i18n.messages, `cycles.${key}`)}: ${value}`);
      paragraph(cycle, `${t('period')}: ${date(memory.cycle.startDate)} → ${date(memory.cycle.targetDate)}`, true);
      paragraph(cycle, `${t('updated')}: ${date(memory.cycle.updatedAt)}`, true);
    } else paragraph(cycle, t('cycleEmpty'));
    const availability = section('availability', 'availabilityOrigin', '/ai-coach.html');
    if (!memory.availability.length) paragraph(availability, t('availabilityEmpty'));
    if (memory.availability.length > 0 && memory.availability.length < 7) paragraph(availability, t('availabilityIncomplete'));
    for (const row of memory.availability) {
      const periods = row.periods.map((period) => translate(i18n.messages, `aiCoach.periods.${period}`)).join(', ');
      const day = translate(i18n.messages, `aiCoach.days.${row.day}`);
      paragraph(availability, `${day}: ${row.canTrain ? `${periods} · ${row.minutes} ${t('minutesMax')} · ${row.location}` : t('unavailable')}`);
      if (row.periods.length > 1) paragraph(availability, t('availabilityReview'), true);
      paragraph(availability, `${t('updated')}: ${date(row.updatedAt)}`, true);
    }
    for (const [key, rows] of [['recent', memory.recent], ['upcoming', memory.upcoming], ['comparables', memory.comparables]]) {
      const card = section(key, 'sessionOrigin', '/calendar.html');
      if (key !== 'comparables') paragraph(card, key === 'recent'
        ? `${date(memory.ranges.detailedFrom)} → ${date(memory.asOf)}`
        : `${date(memory.asOf)} → ${date(memory.ranges.plannedTo)}`, true);
      if (!rows.length) paragraph(card, t('sessionsEmpty'));
      for (const row of rows) {
        const article = document.createElement('article');
        paragraph(article, `${date(row.date)} · ${row.planned.treino || row.planned.tipo || t('unknown')}`);
        if (row.planned.detalhes) paragraph(article, row.planned.detalhes);
        const actual = row.actual;
        paragraph(article, actual.completed ? t('completed') : t('planned'), true);
        const metrics = [];
        if (actual.fit_distance !== null) metrics.push(formatDistance(actual.fit_distance, getUserPreferences().distance_unit));
        if (actual.fit_duration) metrics.push(actual.fit_duration);
        if (actual.fit_avg_pace) metrics.push(formatPaceFromMetric(actual.fit_avg_pace, getUserPreferences().distance_unit));
        if (metrics.length) paragraph(article, metrics.join(' · '));
        for (const [field, label, unit] of [['fit_avg_hr', 'session.manualAvgHr', 'bpm'], ['fit_max_hr', 'session.manualMaxHr', 'bpm'], ['fit_elevation_gain', 'session.manualElevation', ''], ['fit_calories', 'session.resultCalories', 'kcal']])
          if (actual[field] != null) paragraph(article, `${translate(i18n.messages, label)}: ${actual[field]} ${unit}`);
        const report = row.report;
        for (const field of ['feedback_rpe', 'feedback_notas', 'feedback_breathing', 'feedback_muscle', 'feedback_energy', 'feedback_pain'])
          if (report[field] != null && report[field] !== '') {
            const labels = { feedback_breathing: BREATHING_LABEL_KEYS, feedback_muscle: MUSCLE_LABEL_KEYS, feedback_energy: ENERGY_LABEL_KEYS };
            const key = labels[field]?.[report[field]];
            const value = key ? translate(i18n.messages, key) : report[field];
            paragraph(article, `${t(`feedback.${field}`)}: ${value}`);
          }
        if (report.feedback_has_pain === 'yes' || report.feedback_has_pain === 'no')
          paragraph(article, `${t('feedback.feedback_has_pain')}: ${t(report.feedback_has_pain)}`);
        paragraph(article, `${t('sessionOrigin')} · ${date(row.date)}`, true);
        link(article, row.href, t('openSession'), `${key}:${row.href}`); card.append(article);
      }
    }
    const weekly = section('weekly', 'weeklyOrigin', '/calendar.html');
    paragraph(weekly, `${date(memory.ranges.aggregateFrom)} → ${date(memory.ranges.aggregateTo)}`, true);
    if (!memory.weekly.length) paragraph(weekly, t('aggregatesEmpty'));
    for (const row of memory.weekly) {
      paragraph(weekly, `${date(row.weekStart)} · ${row.completed}/${row.planned} ${t('completedCount')} · ${formatDistance(row.distanceKm, getUserPreferences().distance_unit)} · ${Math.round(row.durationSeconds / 60)} ${t('minutes')}`);
      if (row.missingResults) paragraph(weekly, `${t('missingResults')}: ${row.missingResults}`, true);
      if (row.averageRpe !== null) paragraph(weekly, `RPE: ${row.averageRpe.toFixed(1)}`);
    }
    paragraph(root, t('temporalHint'), true);
    paragraph(root, t('selectionHint'), true);
    if (memory.selectionLimited) paragraph(root, t('selectionLimited'), true);
    $('legacyNotice').hidden = !memory.legacyAvailable;
    const updated = memory.profile.fields.experience?.updatedAt;
    $('profileSource').textContent = updated
      ? `${t('authorities.user_report')} · ${t('updated')}: ${date(updated)}`
      : t('profileEmpty');
    $('memoryStatus').textContent = `${t('asOf')}: ${date(memory.asOf)}`;
    if (focusedKey) [...root.querySelectorAll('a')].find((a) => a.dataset.memoryLink === focusedKey)?.focus();
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
