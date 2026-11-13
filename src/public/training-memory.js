import {
  initShell,
  getShellI18n,
  getUserPreferences,
  showShellToast,
} from './shared/shell.js';
import { requestJson } from './shared/api.js';
import { translate } from './shared/i18n.js';
import { formatDate } from './shared/date.js';
import { formatDistance, formatPaceFromMetric } from './shared/units.js';
import { BREATHING_LABEL_KEYS, MUSCLE_LABEL_KEYS, ENERGY_LABEL_KEYS } from './shared/analysis-prompts.js';
import { DAY_DB_KEYS } from './shared/workout-prompts.js';
import { memorySummary, memoryQuality } from './shared/memory-insights.js';

async function initMemory() {
  const user = await initShell();
  if (!user) return;
  const $ = (id) => document.getElementById(id);
  const i18n = getShellI18n();
  const t = (key) => translate(i18n.messages, `memory.${key}`);
  const fields = ['experience'];
  const dirty = new Set();
  // Character count and an unsaved-changes cue for prior experience.
  function renderExperienceMeta() {
    const field = $('experience');
    $('experienceCount').textContent = translate(i18n.messages, 'memory.experienceCount', { count: field.value.length, max: field.maxLength });
    const saved = memory?.profile?.fields?.experience?.value ?? '';
    $('experienceUnsaved').hidden = !dirty.has('experience') || field.value === saved;
  }
  for (const field of fields)
    $(field).addEventListener('input', () => { dirty.add(field); renderExperienceMeta(); });
  let memory = null;
  let busy = false;
  // A write in flight (experience or interpretation). A tab load never clears it.
  let mutating = false;
  // Which AI task's context is shown. Each load is numbered so a slower reply
  // for a previously selected task never replaces the current one.
  let purpose = 'cycle';
  let loadSeq = 0;
  const memoryUrl = () => `/api/ai/memory?purpose=${encodeURIComponent(purpose)}`;
  let loaded = false;
  let errorKey = null;
  function controls() {
    $('profileForm').querySelector('[type=submit]').disabled = !loaded || busy;
    $('reloadMemory').disabled = busy;
    $('refreshMemoryVersion').disabled = busy;
    for (const action of document.querySelectorAll('[data-memory-action]'))
      action.disabled = busy;
    // Task tabs wait for a write to settle: its completion updates this task's data.
    for (const tab of document.querySelectorAll('#purposeTabs [role=tab]')) {
      if (mutating) tab.setAttribute('aria-disabled', 'true');
      else tab.removeAttribute('aria-disabled');
    }
  }
  function error(error, focus = true, retryLoad = false) {
    const code = error?.codes?.[0];
    errorKey =
      code && t(`errors.${code}`) !== `memory.errors.${code}`
        ? `errors.${code}`
        : 'errors.generic';
    $('memoryStatus').textContent = '';
    const message = t(errorKey);
    $('memoryError').textContent = message;
    $('memoryError').classList.remove('hidden');
    $('reloadMemory').hidden = !retryLoad;
    $('refreshMemoryVersion').hidden = code !== 'memoryConflict';
    if (focus) $('memoryError').focus();
  }
  function clearError() {
    errorKey = null;
    $('memoryError').classList.add('hidden');
    $('reloadMemory').hidden = true;
    $('refreshMemoryVersion').hidden = true;
    for (const input of document.querySelectorAll('[aria-invalid]')) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }
  // One sentence naming the task whose context is shown.
  function renderTask(date) {
    const task = memory.task;
    let text;
    if (memory.purpose === 'cycle')
      text = memory.cycle && task.cycleId ? translate(i18n.messages, 'memory.task.cycle', { objective: memory.cycle.objective }) : t('task.cycleNone');
    else if (memory.purpose === 'workouts')
      text = `${translate(i18n.messages, 'memory.task.workouts', { date: date(task.weekStart) })} ${t('task.weatherNote')}`;
    else
      text = task.session
        ? translate(i18n.messages, 'memory.task.analysis', { date: date(task.session.date), name: task.session.planned.treino || task.session.planned.tipo || t('unknown') })
        : t('task.analysisNone');
    $('purposeTask').textContent = text;
  }
  // Headline numbers and the memory-quality checklist, from the received projection only.
  function renderInsights(date) {
    const root = $('memoryInsights');
    const make = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text != null) element.textContent = text;
      return element;
    };
    const tr = (key, params) => translate(i18n.messages, `memory.${key}`, params);
    const unit = getUserPreferences().distance_unit;
    const summary = memorySummary(memory);
    const stats = make('section', 'memory-stats');
    stats.setAttribute('aria-label', tr('stats.label'));
    const tile = (label, value, sub, extra = null, tone = '') => {
      const card = make('div', `memory-stat${tone ? ` memory-stat-${tone}` : ''}`);
      card.append(make('p', 'memory-stat-label', label), make('p', 'memory-stat-value', value));
      if (extra) card.append(extra);
      card.append(make('p', 'memory-stat-sub', sub));
      stats.append(card);
    };
    // Weekly volume bars: decorative; the same numbers are in the accessible label.
    const max = Math.max(...summary.series.map((week) => week.distanceKm), 0);
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chart.setAttribute('viewBox', `0 0 ${summary.series.length * 14} 32`);
    chart.setAttribute('class', 'memory-spark');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', tr('stats.chartLabel', { weeks: summary.series.map((week) => `${date(week.weekStart)} ${formatDistance(week.distanceKm, unit)}`).join(', ') }));
    summary.series.forEach((week, index) => {
      const height = max ? Math.max(2, Math.round((week.distanceKm / max) * 30)) : 2;
      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.setAttribute('x', String(index * 14 + 2)); bar.setAttribute('y', String(32 - height));
      bar.setAttribute('width', '10'); bar.setAttribute('height', String(height)); bar.setAttribute('rx', '2');
      bar.setAttribute('class', index === summary.series.length - 1 ? 'memory-spark-current' : '');
      chart.append(bar);
    });
    tile(tr('stats.volume'), formatDistance(summary.volume.distanceKm, unit), tr('stats.volumeSub'), chart);
    const consistency = summary.consistency;
    tile(tr('stats.consistency'), consistency.ratio === null ? '—' : `${Math.round(consistency.ratio * 100)}%`,
      consistency.planned ? tr('stats.consistencySub', consistency) : tr('stats.consistencyEmpty'));
    const effort = summary.effort.recent;
    tile(tr('stats.effort'), effort === null ? '—' : tr('stats.effortValue', { value: effort.toFixed(1) }), tr(`stats.effortTrend.${summary.effort.trend ?? 'none'}`));
    const concerns = summary.concerns;
    tile(tr('stats.alerts'), String(concerns.count),
      concerns.latest ? tr('stats.alertsSub', { date: date(concerns.latest.date) }) : tr('stats.alertsNone'), null, concerns.count ? 'alert' : '');
    root.replaceChildren(stats);
    if (summary.partial) root.append(make('p', 'field-hint memory-stats-partial', tr('stats.partial')));
    const items = memoryQuality(memory);
    const quality = make('section', 'shoe-card memory-section memory-quality');
    const heading = make('h2', '', tr('quality.title')); heading.id = 'memory-quality';
    quality.setAttribute('aria-labelledby', heading.id);
    const header = make('header', 'memory-card-header');
    header.append(heading, make('span', 'memory-quality-score', tr('quality.score', { done: items.filter((item) => item.ok).length, total: items.length })));
    quality.append(header, make('p', 'field-hint', tr('quality.intro')));
    const list = make('ul', 'memory-quality-list');
    for (const item of items) {
      const row = make('li', `memory-quality-item ${item.ok ? 'is-ok' : 'is-todo'}`);
      row.dataset.quality = item.key;
      const icon = make('span', 'memory-quality-icon', item.ok ? '✓' : '!'); icon.setAttribute('aria-hidden', 'true');
      const textKey = item.key === 'plan' ? (item.ok ? 'ok' : item.state) : item.ok ? 'ok' : 'todo';
      row.append(icon, make('span', 'memory-quality-text', tr(`quality.items.${item.key}.${textKey}`, { count: item.count })));
      if (!item.ok) {
        const action = make('a', 'memory-source', tr(`quality.items.${item.key}.action`));
        action.href = item.href; action.dataset.memoryLink = `quality:${item.key}`;
        row.append(action);
      }
      list.append(row);
    }
    quality.append(list);
    root.append(quality);
  }
  // States what was left out, with counts, only when something was.
  function renderOmissions() {
    const notice = $('selectionNotice');
    const omissions = memory.omissions;
    const counts = { ...omissions.budget };
    let planning = 0;
    for (const key of ['architecture', 'phases', 'indicators', 'adaptations', 'uncertainties']) { planning += counts[key] || 0; delete counts[key]; }
    if (planning) counts.planning = planning;
    const items = Object.entries(counts).map(([key, count]) => translate(i18n.messages, `memory.omitted.${key}`, { count }));
    const lines = [];
    if (items.length) lines.push(translate(i18n.messages, 'memory.omitted.intro', { items: items.join(', ') }));
    if (omissions.reducedDetails) lines.push(translate(i18n.messages, 'memory.omitted.reduced', { count: omissions.reducedDetails }));
    if (omissions.historical) lines.push(translate(i18n.messages, 'memory.omitted.historical', { count: omissions.historical, weeks: Math.round((Date.parse(memory.asOf) - Date.parse(memory.ranges.aggregateFrom)) / 604800000) }));
    notice.replaceChildren(...lines.map((line) => { const p = document.createElement('p'); p.textContent = line; return p; }));
    notice.hidden = !lines.length;
  }
  function renderOverview() {
    const root = $('memoryOverview');
    const scope = [root, $('memoryInsights')];
    const focusedKey = scope.some((element) => element.contains(document.activeElement)) ? document.activeElement.dataset.memoryLink : null;
    const focusedAction = root.contains(document.activeElement) ? document.activeElement.dataset.memoryAction : null;
    const focusedInterpretationId = root.contains(document.activeElement)
      ? document.activeElement.closest('[data-memory-item]')?.dataset.memoryItem : null;
    const opened = new Set([...root.querySelectorAll('details[open]')].map((element) => element.dataset.memoryDisclosure));
    root.replaceChildren();
    const date = (value) => value ? formatDate(value.slice(0, 10), i18n.language) : t('unknown');
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text != null) element.textContent = text;
      return element;
    };
    const paragraph = (parent, value, hint = false) => { const p = node('p', hint ? 'field-hint' : '', value); parent.append(p); return p; };
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
      if (key !== 'interpretations') {
        const actions = { cycle: 'editCycle', availability: 'editAvailability', plan: 'openPlanning', shoes: 'openShoes', previousCycles: 'openCycles' };
        link(header, href, t(actions[key] ?? 'openCalendar'), key);
      }
      card.append(header); paragraph(card, t(origin), true);
      parent.append(card); return card;
    };
    const metric = (parent, label, value) => {
      const item = node('div', 'memory-metric');
      item.append(node('dt', '', label), node('dd', '', value)); parent.append(item);
    };
    renderTask(date);
    renderInsights(date);
    renderOmissions();
    const cycle = section('cycle', 'cycleOrigin', '/cycles.html', top);
    if (memory.cycle) {
      paragraph(cycle, memory.cycle.objective);
      const goals = node('dl', 'memory-facts'); cycle.append(goals);
      for (const [key, value] of [['primaryGoal', memory.cycle.primaryGoal], ['secondaryGoal', memory.cycle.secondaryGoal], ['otherEvents', memory.cycle.otherEvents]])
        if (value) metric(goals, translate(i18n.messages, `cycles.${key}`), value);
      if (memory.cycle.status) metric(goals, t('status'), translate(i18n.messages, `cycles.status.${memory.cycle.status}`));
      metric(goals, t('period'), `${date(memory.cycle.startDate)} → ${date(memory.cycle.targetDate)}`);
      paragraph(cycle, `${t('updated')}: ${date(memory.cycle.updatedAt)}`, true).classList.add('memory-updated');
    } else paragraph(cycle, t('cycleEmpty'));
    const availability = section('availability', 'availabilityOrigin', '/ai-coach.html', top);
    if (!memory.availability.length) paragraph(availability, t('availabilityEmpty'));
    else {
      if (memory.availability.length < 7) paragraph(availability, t('availabilityIncomplete'), true);
      const days = getUserPreferences().first_day_of_week === 'Sunday' ? [DAY_DB_KEYS[6], ...DAY_DB_KEYS.slice(0, 6)] : DAY_DB_KEYS;
      const rows = [...memory.availability].sort((a, b) => days.indexOf(a.day) - days.indexOf(b.day));
      const sameUpdate = new Set(rows.map((row) => row.updatedAt)).size === 1;
      const locations = new Set(rows.filter((row) => row.canTrain).map((row) => row.location));
      const dayList = node('ul', 'memory-days');
      dayList.setAttribute('aria-label', t('availability'));
      for (const row of rows) {
        const item = node('li', `memory-day${row.canTrain ? '' : ' is-off'}`); item.dataset.day = row.day;
        item.append(node('strong', 'memory-day-name', translate(i18n.messages, `aiCoach.days.${row.day}`)));
        if (row.canTrain) {
          const periods = row.periods.map((period) => translate(i18n.messages, `aiCoach.periods.${period}`)).join(', ');
          item.append(node('span', 'memory-day-period', periods || t('unknown')),
            node('span', 'memory-day-minutes', row.minutes == null ? t('unknown') : `${row.minutes} ${t('minutes')}`));
          if (locations.size > 1) item.append(node('span', 'memory-day-location', row.location || t('unknown')));
        } else item.append(node('span', 'memory-day-period', t('unavailable')));
        if (row.periods.length > 1) item.append(node('span', 'field-hint memory-row-note', t('availabilityReview')));
        if (!sameUpdate) item.append(node('span', 'field-hint memory-row-note', `${t('updated')}: ${date(row.updatedAt)}`));
        dayList.append(item);
      }
      availability.append(dayList);
      if (locations.size === 1) paragraph(availability, translate(i18n.messages, 'memory.availabilityLocation', { location: [...locations][0] || t('unknown') })).classList.add('memory-day-place');
      paragraph(availability, t('durationHint'), true);
      if (sameUpdate) paragraph(availability, `${t('updated')}: ${date(rows[0].updatedAt)}`, true).classList.add('memory-updated');
    }
    if (memory.purpose !== 'cycle') {
      const plan = section('plan', 'planOrigin', '/cycles.html');
      const applied = memory.appliedPlan;
      if (!applied) paragraph(plan, t('planEmpty'));
      else {
        paragraph(plan, translate(i18n.messages, 'memory.planVersion', { version: applied.version, date: date(applied.appliedAt) }), true);
        if (applied.compatibilityError) paragraph(plan, t('planIncompatible'));
        else {
          if (applied.outdated) paragraph(plan, t('planOutdated'), true);
          const facts = node('dl', 'memory-facts'); plan.append(facts);
          metric(facts, t('period'), `${date(applied.start)} → ${date(applied.end)}`);
          if (applied.currentPhase) metric(facts, t('currentPhase'), `${applied.currentPhase.name} · ${applied.currentPhase.objective}`);
          if (applied.architecture.length) {
            const list = node('ol', 'memory-phases');
            for (const phase of applied.architecture) list.append(node('li', applied.currentPhase && phase.start === applied.currentPhase.start && phase.name === applied.currentPhase.name ? 'memory-phase-current' : '', `${phase.name} · ${date(phase.start)} → ${date(phase.end)}`));
            metric(facts, t('phases'), '');
            facts.lastElementChild.querySelector('dd').append(list);
          }
          if (applied.indicators?.length) metric(facts, t('indicators'), applied.indicators.join(' · '));
        }
      }
    }
    // Coach hypotheses come right after the goals and plan: they are what the
    // athlete is asked to confirm, correct or dismiss.
    const interpretationCard = section('interpretations', 'interpretationsOrigin', '/calendar.html');
    // One dated session: planned name, priority badge, recorded metrics, dated
    // reports, optional planned details and the link to its source.
    const sessionArticle = (row, key) => {
      const article = node('article', 'memory-session');
      const head = node('div', 'memory-session-head');
      const titleBlock = node('div', 'memory-session-title');
      titleBlock.append(node('p', 'memory-session-date', date(row.date)));
      const title = node('h3', '', row.planned.treino || row.planned.tipo || t('unknown'));
      if (row.priority) title.append(' ', node('span', `memory-badge memory-badge-${row.priority}`, translate(i18n.messages, `memory.priority.${row.priority}`)));
      titleBlock.append(title);
      const side = node('div', 'memory-session-side');
      side.append(node('span', `memory-status ${row.actual.completed ? 'is-done' : 'is-planned'}`, t(row.actual.completed ? 'statusDone' : 'statusPlanned')));
      link(side, row.href, t('openSession'), `${key}:${row.href}`);
      head.append(titleBlock, side);
      article.append(head);
      const actual = row.actual;
      const unit = getUserPreferences().distance_unit;
      const chips = node('ul', 'memory-chips');
      const chip = (label, value, extra = '') => {
        const item = node('li', `memory-chip${extra}`);
        item.append(node('span', 'memory-chip-label', label), document.createTextNode(` ${value}`));
        chips.append(item);
      };
      if (Number.isInteger(row.report.feedback_rpe)) {
        const item = node('li', `memory-chip memory-rpe memory-rpe-${row.report.feedback_rpe}`, translate(i18n.messages, 'memory.rpeChip', { value: row.report.feedback_rpe }));
        chips.append(item);
      }
      if (actual.fit_distance != null) chip(t('distance'), formatDistance(actual.fit_distance, unit));
      if (actual.fit_duration) chip(t('duration'), actual.fit_duration);
      if (actual.fit_avg_pace) chip(t('pace'), formatPaceFromMetric(actual.fit_avg_pace, unit));
      for (const [field, label, suffix] of [['fit_avg_hr', 'session.manualAvgHr', 'bpm'], ['fit_max_hr', 'session.manualMaxHr', 'bpm'], ['fit_elevation_gain', 'session.manualElevation', 'm'], ['fit_calories', 'session.resultCalories', 'kcal']])
        if (actual[field] != null) chip(translate(i18n.messages, label), `${actual[field]} ${suffix}`);
      if (chips.childElementCount) article.append(chips);
      const report = row.report;
      const feedback = node('div', 'memory-feedback');
      for (const field of ['feedback_pain', 'feedback_notas', 'feedback_breathing', 'feedback_muscle', 'feedback_energy'])
        if (report[field] != null && report[field] !== '') {
          const labels = { feedback_breathing: BREATHING_LABEL_KEYS, feedback_muscle: MUSCLE_LABEL_KEYS, feedback_energy: ENERGY_LABEL_KEYS };
          const labelKey = labels[field]?.[report[field]];
          const value = labelKey ? translate(i18n.messages, labelKey) : report[field];
          paragraph(feedback, `${t(`feedback.${field}`)}: ${value}`).classList.toggle('memory-feedback-alert', field === 'feedback_pain');
        }
      if (report.feedback_has_pain === 'yes' || report.feedback_has_pain === 'no')
        paragraph(feedback, `${t('feedback.feedback_has_pain')}: ${t(report.feedback_has_pain)}`).classList.toggle('memory-feedback-alert', report.feedback_has_pain === 'yes');
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
      return article;
    };
    // The analysis tab shows the analyzed session itself: it is the task's
    // resource, so the selection keeps it out of the recent list.
    if (memory.purpose === 'analysis' && memory.task.session) {
      const analyzed = section('analyzed', 'analyzedOrigin', '/calendar.html');
      analyzed.append(sessionArticle(memory.task.session, 'analyzed'));
    }
    for (const [key, rows] of [['recent', memory.recent], ['upcoming', memory.upcoming], ['comparables', memory.comparables]]) {
      const card = section(key, 'sessionOrigin', '/calendar.html');
      if (key !== 'comparables') paragraph(card, key === 'recent'
        ? `${date(memory.ranges.detailedFrom)} → ${date(memory.asOf)}`
        : `${date(memory.asOf)} → ${date(memory.ranges.plannedTo)}`, true);
      if (!rows.length) { card.classList.add('memory-empty'); paragraph(card, t('sessionsEmpty')); }
      for (const row of rows) card.append(sessionArticle(row, key));
    }
    const weekly = section('weekly', 'weeklyOrigin', '/calendar.html');
    paragraph(weekly, `${date(memory.ranges.aggregateFrom)} → ${date(memory.ranges.aggregateTo)}`, true);
    if (!memory.weekly.length) { weekly.classList.add('memory-empty'); paragraph(weekly, t('aggregatesEmpty')); }
    else {
      const unit = getUserPreferences().distance_unit;
      const max = Math.max(...memory.weekly.map((row) => row.distanceKm), 0);
      const weeks = node('ol', 'memory-weeks');
      weeks.setAttribute('aria-label', t('weekly'));
      for (const row of memory.weekly) {
        const item = node('li', 'memory-week');
        item.append(node('span', 'memory-week-label', date(row.weekStart)));
        const bar = node('span', 'memory-week-bar'); bar.setAttribute('aria-hidden', 'true');
        const fill = node('span', 'memory-week-fill'); fill.style.width = `${max ? Math.max(2, (row.distanceKm / max) * 100) : 0}%`;
        bar.append(fill);
        item.append(bar, node('strong', 'memory-week-value', formatDistance(row.distanceKm, unit)));
        const detail = translate(i18n.messages, 'memory.weeklyRow', { sessions: `${row.completed}/${row.planned}`, rpe: row.averageRpe === null ? t('unknown') : row.averageRpe.toFixed(1) });
        item.append(node('span', 'memory-week-detail', row.missingResults ? `${detail} · ${translate(i18n.messages, 'memory.weeklyMissing', { count: row.missingResults })}` : detail));
        weeks.append(item);
      }
      weekly.append(weeks);
      paragraph(weekly, t('totalsHint'), true);
    }
    const pair = node('div', 'memory-pair'); root.append(pair);
    const shoes = section('shoes', 'shoesOrigin', '/shoes.html', pair);
    if (!memory.shoes.length) paragraph(shoes, t('shoesEmpty'));
    else {
      const list = node('dl', 'memory-facts'); shoes.append(list);
      for (const shoe of memory.shoes) {
        const unit = getUserPreferences().distance_unit;
        const mileage = shoe.targetMileage
          ? translate(i18n.messages, 'memory.shoeMileage', { mileage: formatDistance(shoe.mileage ?? 0, unit), target: formatDistance(shoe.targetMileage, unit) })
          : formatDistance(shoe.mileage ?? 0, unit);
        metric(list, `${shoe.brand} ${shoe.model}`, mileage);
      }
    }
    if (memory.purpose === 'cycle') {
      const previous = section('previousCycles', 'previousCyclesOrigin', '/cycles.html', pair);
      if (!memory.previousCycles.length) paragraph(previous, t('previousCyclesEmpty'));
      else {
        const list = node('dl', 'memory-facts'); previous.append(list);
        for (const row of memory.previousCycles)
          metric(list, row.objective, `${translate(i18n.messages, `cycles.status.${row.status}`)} · ${date(row.startDate)} → ${date(row.targetDate)}`);
      }
    }
    if (!memory.interpretations?.length) paragraph(interpretationCard, t('interpretationsEmpty'));
    for (const item of memory.interpretations || []) {
      const article = node('article', 'memory-session memory-interpretation');
      article.dataset.memoryItem = item.id;
      article.tabIndex = -1;
      article.append(node('h3', '', `${t(`interpretationKinds.${item.kind}`)} · ${date(item.dia)}`));
      if (item.correction_text) {
        paragraph(article, `${t('interpretationOriginal')}: ${item.originalText}`);
        paragraph(article, `${t('interpretationCorrectionLabel')}: ${item.correction_text}`);
      } else paragraph(article, item.text, false);
      paragraph(article, t(`interpretationStates.${item.disposition}`), true);
      paragraph(article, translate(i18n.messages, `memory.interpretationInclusion.${item.inclusion}`), true);
      link(article, item.href, t('openSession'), `interpretation:${item.href}`);
      const call = async (action, textValue, focusAction = action === 'confirm' ? 'correct' : action) => {
        if (busy) return;
        const interpretationId = item.id;
        busy = true; mutating = true; controls();
        try {
          const body = { expected_version: item.version };
          if (action === 'correct') body.text = textValue;
          const saved = await requestJson(`/api/ai/interpretations/${encodeURIComponent(item.id)}/${action}`, body);
          if (memory) memory.interpretations = memory.interpretations.map((entry) => entry.id === item.id ? {
            ...entry,
            disposition: saved.interpretation.disposition,
            correction_text: saved.interpretation.correction,
            originalText: saved.interpretation.text,
            version: saved.interpretation.version,
            updated_at: saved.interpretation.updatedAt,
            // Membership is unknown until the memory is read again; never shown as used.
            inclusion: saved.interpretation.disposition === 'dismissed' ? 'dismissed' : 'unverified',
            text: saved.interpretation.disposition === 'corrected' ? saved.interpretation.correction : saved.interpretation.text,
          } : entry);
          clearError();
          if (memory) { loaded = true; renderOverview(); }
          if (document.activeElement === document.body) {
            const equivalent = [...root.querySelectorAll('[data-memory-action]')]
              .find((control) => control.dataset.memoryAction === `${interpretationId}:${focusAction}`);
            (equivalent || root.querySelector(`[data-memory-item="${CSS.escape(interpretationId)}"]`))?.focus();
          }
          showShellToast(i18n.messages, 'memory.interpretationSaved');
          // The write is settled: tabs may change again. The follow-up read is
          // numbered like any load, so a tab selected meanwhile keeps its own read.
          mutating = false; controls();
          const seq = ++loadSeq;
          try {
            const fresh = await requestJson(memoryUrl(), undefined, 'GET');
            if (seq === loadSeq) { memory = fresh; loaded = true; clearError(); renderOverview(); }
          } catch { if (seq === loadSeq) error({ codes: ['memoryReadFailed'] }, false, true); }
        } catch (e) { error(e, false); }
        finally {
          busy = false; mutating = false; controls();
          if (document.activeElement === document.body || !document.activeElement?.isConnected) {
            const equivalent = [...root.querySelectorAll('[data-memory-action]')]
              .find((control) => control.dataset.memoryAction === `${interpretationId}:${focusAction}`);
            (equivalent || root.querySelector(`[data-memory-item="${CSS.escape(interpretationId)}"]`))?.focus();
          }
        }
      };
      if (['pending', 'confirmed', 'corrected'].includes(item.disposition)) {
        const actions = node('div', 'memory-interpretation-actions');
        const button = (label, action) => {
          const control = node('button', 'btn-secondary btn-small', label);
          control.type = 'button';
          control.dataset.memoryAction = `${item.id}:${action}`;
          control.disabled = busy;
          control.addEventListener('click', () => {
            if (action === 'correct') { editor.open = true; textarea.focus(); }
            else void call(action);
          });
          return control;
        };
        if (item.disposition === 'pending') actions.append(button(t('interpretationConfirm'), 'confirm'));
        actions.append(button(t('interpretationCorrect'), 'correct'), button(t('interpretationDiscard'), 'discard'));
        article.append(actions);
        const editor = node('details', 'memory-interpretation-editor');
        editor.dataset.memoryDisclosure = `interpretation:${item.id}`;
        editor.open = opened.has(editor.dataset.memoryDisclosure);
        const summary = node('summary', '', t('interpretationCorrect'));
        const textarea = node('textarea', 'input-control'); textarea.maxLength = 400; textarea.rows = 3; textarea.value = item.disposition === 'corrected' ? item.correction_text || '' : '';
        textarea.setAttribute('aria-label', t('interpretationCorrectionLabel'));
        const save = node('button', 'btn-primary btn-small', t('interpretationSaveCorrection')); save.type = 'button';
        save.dataset.memoryAction = `${item.id}:save-correction`;
        save.addEventListener('click', () => void call('correct', textarea.value.trim(), 'save-correction'));
        editor.append(summary, textarea, save); article.append(editor);
      }
      interpretationCard.append(article);
    }
    $('legacyNotice').hidden = !memory.legacyAvailable;
    const updated = memory.profile.fields.experience?.updatedAt;
    $('profileSource').textContent = updated
      ? `${t('authorities.user_report')} · ${t('updated')}: ${date(updated)}`
      : t('profileEmpty');
    $('memoryStatus').textContent = `${t('asOf')}: ${date(memory.asOf)}`;
    renderExperienceMeta();
    if (focusedKey) [...document.querySelectorAll('#memoryInsights [data-memory-link], #memoryOverview [data-memory-link]')].find((a) => a.dataset.memoryLink === focusedKey)?.focus();
    if (focusedAction) {
      const equivalent = [...root.querySelectorAll('[data-memory-action]')].find((a) => a.dataset.memoryAction === focusedAction);
      if (equivalent) equivalent.focus();
      else if (focusedInterpretationId) root.querySelector(`[data-memory-item="${CSS.escape(focusedInterpretationId)}"]`)?.focus();
    }
    controls();
  }
  async function mutate(action) {
    if (busy) return;
    busy = true;
    mutating = true;
    controls();
    clearError();
    try {
      await action();
      showShellToast(i18n.messages, 'memory.saved');
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      mutating = false;
      controls();
    }
  }
  async function load({ switching = false } = {}) {
    if (busy && !switching) return;
    const seq = ++loadSeq;
    const trigger = document.activeElement;
    const recoverFocus = trigger === $('reloadMemory') || trigger === $('refreshMemoryVersion');
    busy = true;
    controls();
    clearError();
    $('memoryStatus').textContent = t('loading');
    $('memoryPurposePanel').setAttribute('aria-busy', 'true');
    try {
      const result = await requestJson(memoryUrl(), undefined, 'GET');
      if (seq !== loadSeq) return;
      memory = result;
      loaded = true;
      for (const field of fields)
          if (!dirty.has(field))
            $(field).value = memory.profile.fields[field]?.value || '';
      renderOverview();
      if (recoverFocus && document.activeElement === document.body)
        (trigger === $('refreshMemoryVersion') ? $('experience') : document.querySelector('.memory-header h1')).focus();
    } catch (e) {
      // A failure of a superseded read is not shown over the current task.
      if (seq === loadSeq) error(e, !switching, true);
    } finally {
      if (seq === loadSeq) {
        busy = mutating;
        $('memoryPurposePanel').removeAttribute('aria-busy');
        if (!memory) $('purposeTask').textContent = '';
        controls();
      }
    }
  }
  for (const id of ['reloadMemory', 'refreshMemoryVersion'])
    $(id).addEventListener('click', () => { if (!$(id).hidden) load(); });
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
      if ($('experience').value === submitted) dirty.delete('experience');
      if (memory) { memory.profile = saved.profile; renderOverview(); }
      renderExperienceMeta();
    });
  });
  // Purpose tabs: roving tabindex, arrows/Home/End, and a fresh read per task.
  const tabs = [...document.querySelectorAll('#purposeTabs [role=tab]')];
  function selectPurpose(tab, focus = false) {
    if (mutating) return;
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    $('memoryPurposePanel').setAttribute('aria-labelledby', tab.id);
    if (focus) tab.focus();
    if (purpose === tab.dataset.purpose) return;
    purpose = tab.dataset.purpose;
    // The previous task's context must never sit under the newly selected tab:
    // clear it now; it is replaced on success, or by the error and retry on failure.
    memory = null;
    loaded = false;
    $('memoryOverview').replaceChildren();
    $('memoryInsights').replaceChildren();
    $('selectionNotice').hidden = true;
    $('purposeTask').textContent = t('loading');
    void load({ switching: true });
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectPurpose(tab));
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      const target = { ArrowRight: tabs[(index + 1) % tabs.length], ArrowLeft: tabs[(index + tabs.length - 1) % tabs.length], Home: tabs[0], End: tabs.at(-1) }[event.key];
      if (!target) return;
      event.preventDefault();
      selectPurpose(target, true);
    });
  }
  document.addEventListener('kinesis:preferences-changed', () => { if (memory) renderOverview(); });
  document.addEventListener('app:languagechange', () => {
    if (memory) renderOverview();
    if (errorKey) $('memoryError').textContent = t(errorKey);
    renderExperienceMeta();
  });
  await load();
}
if (typeof document !== 'undefined') initMemory();
