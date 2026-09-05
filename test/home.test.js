'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');
const en = require(join(publicDir, 'locales', 'en.json'));
const pt = require(join(publicDir, 'locales', 'pt.json'));

const {
  ZENQUOTES_URL,
  QUOTE_TIMEOUT_MS,
  HERO_IMAGES,
  startOfDay,
  isoDate,
  heroImageIndex,
  heroImageFor,
  mondayOfWeek,
  weekRange,
  trainingsInRange,
  parseDurationToSeconds,
  accumulateWeeklyMetrics,
  formatDistanceKm,
  formatDuration,
  parseIsoDate,
  weeksBetween,
  currentWeekNumber,
  cycleProgress,
  cycleWeekText,
  cycleObjectiveText,
  cycleCardContent,
  metricsCardContent,
  randomFallbackQuote,
  normalizeZenQuote,
  loadQuote,
  applyHeroImage,
  WEEKDAY_KEYS,
  weekDays,
  trainingDaySet,
  weekDayState,
  buildWeekDayMarkup,
  renderWeekDays,
  applyCycleVisibility,
  DEFAULT_DISPLAY_LANGUAGE,
  formatTargetDate,
  daysRemainingUntil,
  daysRemainingText,
} = require(join(publicDir, 'home.js'));

function readHomeHtml() {
  return readFileSync(join(publicDir, 'home.html'), 'utf8');
}

function readHomeJs() {
  return readFileSync(join(publicDir, 'home.js'), 'utf8');
}

function readHomeCss() {
  return readFileSync(join(publicDir, 'home.css'), 'utf8');
}

function stubDate(year, month, day) {
  const RealDate = globalThis.Date;
  const fixed = new RealDate(year, month, day, 10, 0, 0);
  class StubDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed.getTime());
      else super(...args);
    }
    static now() {
      return fixed.getTime();
    }
  }
  return { StubDate, restore: () => { globalThis.Date = RealDate; } };
}

// ── HTML structure ─────────────────────────────────────────────

test('home.html ships the hero, cycle, and metrics dashboard skeleton', () => {
  const html = readHomeHtml();
  assert.match(html, /id="heroBanner"/);
  assert.match(html, /id="heroQuoteLoading"/);
  assert.match(html, /id="heroQuote"/);
  assert.match(html, /id="heroQuoteText"/);
  assert.match(html, /id="heroQuoteAuthor"/);
  assert.match(html, /id="cycleEmpty"/);
  assert.match(html, /id="cycleActive"/);
  assert.match(html, /id="cycleName"/);
  assert.match(html, /id="cycleObjective"/);
  assert.match(html, /id="cycleDaysLeft"/);
  assert.match(html, /id="cycleTarget"/);
  assert.match(html, /id="cycleWeek"/);
  assert.match(html, /id="cycleProgressRow"/);
  assert.match(html, /id="cycleProgressBar"/);
  assert.match(html, /id="cyclePercent"/);
  assert.match(html, /id="weeklyDistanceValue"/);
  assert.match(html, /id="weeklyTimeValue"/);
  assert.match(html, /id="weekTrackerDays"/);
  assert.match(html, /class="card-action" href="\/cycles\.html" data-i18n-aria-label="home\.actions\.goToCycles"[\s\S]*?data-lucide="external-link"/);
  assert.match(html, /class="card-action" href="\/calendar\.html" data-i18n-aria-label="home\.actions\.goToTrainings"[\s\S]*?data-lucide="external-link"/);
  assert.match(html, /class="dashboard-grid vertical"/);
  assert.match(html, /class="week-tracker"/);
  assert.match(html, /class="week-tracker-days"/);
  assert.doesNotMatch(html, /weeklyTrackerTitle|class="tracker-title"|data-i18n="home\.metrics\.tracker"/);
  assert.ok(
    html.indexOf('<div class="week-tracker"') < html.indexOf('<div class="metrics-grid">'),
    'the weekly tracker appears before the summary metrics'
  );
  assert.match(html, /home\.js/);
  assert.match(html, /shared\/shell\.js/);
  assert.match(html, /shared\/shell\.css/);
  assert.match(html, /home\.css/);
});

test('home.html starts with the empty cycle state visible and the active card hidden', () => {
  const html = readHomeHtml();
  const emptyBlock = html.match(
    /<div id="cycleEmpty" class="empty-state">[\s\S]*?<\/div>\s*<div id="cycleActive"/
  );
  assert.ok(emptyBlock, 'the empty-state block precedes the active card');
  assert.ok(
    emptyBlock[0].includes('No active training cycle'),
    'the "No active cycle" text and CTA live inside the empty-state container'
  );
  assert.ok(emptyBlock[0].includes('href="/cycles.html"'));
  assert.equal(
    /<div id="cycleEmpty" class="empty-state">[\s\S]*?class="hidden">/.test(emptyBlock[0]),
    false,
    'the empty state is NOT hidden by default'
  );
  assert.match(html, /<div id="cycleActive" class="cycle-card hidden">/, 'the active card ships hidden until a cycle loads');
});

test('home.html structures the active card: header with countdown, objective beneath the name', () => {
  const html = readHomeHtml();
  const card = html.match(/<div id="cycleActive" class="cycle-card hidden">[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(card, 'the active cycle card block exists');
  assert.match(
    card[0],
    /<div class="cycle-header">[\s\S]*?<h3 id="cycleName"[\s\S]*?<span id="cycleDaysLeft"/,
    'the countdown chip sits on the right side of the card header row'
  );
  assert.match(
    card[0],
    /<h3 id="cycleName"[^>]*>[\s\S]*?<p id="cycleObjective" class="cycle-objective">/,
    'the objective subtitle renders directly beneath the cycle name'
  );
  assert.match(card[0], /id="cycleDaysLeft" class="days-left" aria-live="polite"/);
});

test('home.cycle.daysRemaining keys pluralize in both locales', () => {
  for (const messages of [en, pt]) {
    assert.equal(typeof messages.home.cycle.daysRemaining.one, 'string');
    assert.equal(typeof messages.home.cycle.daysRemaining.many, 'string');
    assert.equal(typeof messages.home.cycle.daysRemaining.today, 'string');
    assert.equal(typeof messages.home.cycle.daysRemaining.over, 'string');
  }
  assert.equal(en.home.cycle.daysRemaining.one, '1 day remaining');
  assert.equal(en.home.cycle.daysRemaining.many, '{count} days remaining');
  assert.equal(pt.home.cycle.daysRemaining.one, '1 dia restante');
  assert.equal(pt.home.cycle.daysRemaining.many, '{count} dias restantes');
  assert.equal(pt.home.cycle.daysRemaining.today, 'Hoje');
  assert.equal(pt.home.cycle.daysRemaining.over, 'Encerrado');
});

test('cycle objective rendering includes the localized label and value', () => {
  assert.equal(en.home.cycle.targetLabel, 'Target: ');
  assert.equal(pt.home.cycle.targetLabel, 'Alvo: ');
  assert.equal(cycleObjectiveText(en, 'Run under 2h'), 'Target: Run under 2h');
  assert.equal(cycleObjectiveText(pt, 'Correr abaixo de 2h'), 'Alvo: Correr abaixo de 2h');
  assert.equal(cycleObjectiveText(en, ''), '');
});

test('home.html wires every dashboard label to i18n keys shared by both locales', () => {
  const html = readHomeHtml();
  const expectedKeys = [
    'home.pageTitle',
    'home.actions.goToCycles',
    'home.actions.goToTrainings',
    'home.hero.loading',
    'home.hero.ariaLabel',
    'home.cycle.title',
    'home.cycle.emptyTitle',
    'home.cycle.emptyText',
    'home.cycle.startButton',
    'home.cycle.dateLabel',
    'home.cycle.progressAria',
    'home.metrics.title',
    'home.metrics.distance',
    'home.metrics.time',
  ];
  for (const key of expectedKeys) {
    assert.ok(html.includes(key), `home.html must reference ${key}`);
    const lookup = (messages) =>
      key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), messages);
    assert.equal(typeof lookup(en), 'string', `en.json missing ${key}`);
    assert.equal(typeof lookup(pt), 'string', `pt.json missing ${key}`);
  }
  assert.match(html, /data-i18n-aria-label="home\.hero\.ariaLabel"/);
  assert.match(html, /data-i18n-aria-label="home\.cycle\.progressAria"/);
  assert.match(html, /data-i18n-aria-label="home\.metrics\.trackerAria"/);
  assert.match(html, /class="btn-primary"\s+href="\/cycles\.html"/);
});

test('home.days abbreviations exist in both locales and match the weekday keys', () => {
  for (const messages of [en, pt]) {
    for (const key of WEEKDAY_KEYS) {
      assert.equal(typeof messages.home.days[key.split('.')[2]], 'string', `${key} missing value`);
    }
  }
  assert.equal(en.home.days.mon, 'Mon');
  assert.equal(pt.home.days.mon, 'Seg');
  assert.equal(pt.home.days.sat, 'Sáb');
  assert.equal(pt.home.days.sun, 'Dom');
  assert.equal(en.home.metrics.trackerAria, 'Workouts by day, Monday to Sunday');
  assert.equal(pt.home.metrics.trackerAria, 'Treinos por dia, de segunda a domingo');
});

test('home.html fallback quotes stay plural and authored in both locales', () => {
  for (const messages of [en, pt]) {
    const quotes = messages.home.hero.fallbackQuotes;
    assert.ok(Array.isArray(quotes) && quotes.length >= 5, 'at least five fallback quotes');
    for (const quote of quotes) {
      assert.equal(typeof quote.text, 'string', 'quote text is present');
      assert.equal(typeof quote.author, 'string', 'quote author is present');
    }
  }
  const html = readHomeHtml();
  assert.ok(!html.includes(' title='), 'no native HTML title attributes leak a tooltip');
});

// ── Date, ranges and hero rotation ─────────────────────────────

test('startOfDay and isoDate normalize local dates into YYYY-MM-DD keys', () => {
  assert.equal(isoDate(new Date(2026, 7, 17)), '2026-08-17');
  assert.equal(isoDate(new Date(2026, 0, 3)), '2026-01-03');
  const late = startOfDay(new Date(2026, 7, 17, 23, 59, 59));
  assert.equal(late.getHours(), 0, 'midnight start trims the time fraction');
});

test('hero image rotation is deterministic and day-of-week based', () => {
  const sunday = new Date(2026, 7, 16);
  const monday = new Date(2026, 7, 17);
  const saturday = new Date(2026, 7, 22);
  assert.equal(heroImageIndex(sunday), 0);
  assert.equal(heroImageIndex(monday), 1);
  assert.equal(heroImageIndex(saturday), 6 % HERO_IMAGES.length);
  assert.equal(heroImageFor(monday), HERO_IMAGES[1]);
  for (const url of HERO_IMAGES) {
    assert.match(url, /^https:\/\/images\.unsplash\.com\//);
  }
});

test('the monday start and week window always span Monday through Sunday', () => {
  const thursday = new Date(2026, 7, 20);
  assert.equal(isoDate(mondayOfWeek(thursday)), '2026-08-17');
  const saturday = new Date(2026, 7, 8);
  assert.equal(isoDate(mondayOfWeek(saturday)), '2026-08-03');
  const sunday = new Date(2026, 7, 23);
  assert.equal(isoDate(mondayOfWeek(sunday)), '2026-08-17');
  const week = weekRange(thursday);
  assert.equal(week.start, '2026-08-17');
  assert.equal(week.end, '2026-08-23', 'seven days after the Monday');
  assert.equal(Math.round((parseIsoDate(week.end) - parseIsoDate(week.start)) / 86400000), 6);
});

test('weekRange and heroImageFor read a stubbed now for the default bucket', () => {
  const stub = stubDate(2026, 7, 20);
  globalThis.Date = stub.StubDate;
  try {
    const week = weekRange();
    assert.equal(week.start, '2026-08-17');
    assert.equal(week.end, '2026-08-23');
    assert.equal(heroImageFor(), HERO_IMAGES[4]);
  } finally {
    stub.restore();
  }
});

// ── Trainings windowing and metrics ────────────────────────────

test('trainingsInRange keeps only entries whose dia falls inside the window', () => {
  const trainings = [
    { dia: '2026-08-16', tipo: 'Out' },
    { dia: '2026-08-17', tipo: 'In' },
    { dia: '2026-08-23', tipo: 'In' },
    { dia: '2026-08-24', tipo: 'Out' },
    { dia: undefined, tipo: 'Ghost' },
    'junk',
  ];
  const picked = trainingsInRange(trainings, '2026-08-17', '2026-08-23');
  assert.deepEqual(
    picked.map((t) => t.tipo),
    ['In', 'In']
  );
  assert.deepEqual(trainingsInRange(null, '2026-08-17', '2026-08-23'), []);
  assert.deepEqual(trainingsInRange(undefined, '2026-08-17', '2026-08-23'), []);
});

test('parseDurationToSeconds accepts H:MM, MM:SS and H:MM:SS variants', () => {
  assert.equal(parseDurationToSeconds('1:23:45'), 5025);
  assert.equal(parseDurationToSeconds('1:30:00'), 5400);
  assert.equal(parseDurationToSeconds('45:30'), 2730);
  assert.equal(parseDurationToSeconds('9'), 9);
  assert.equal(parseDurationToSeconds('0:00'), 0);
  assert.equal(parseDurationToSeconds(''), 0);
  assert.equal(parseDurationToSeconds('   '), 0);
  assert.equal(parseDurationToSeconds(null), 0);
  assert.equal(parseDurationToSeconds(undefined), 0);
  assert.equal(parseDurationToSeconds(123), 0);
  assert.equal(parseDurationToSeconds('1:x'), 0);
  assert.equal(parseDurationToSeconds('a:b:c'), 0);
});

test('accumulateWeeklyMetrics sums distance and duration across the window (with junk discipline)', () => {
  const totals = accumulateWeeklyMetrics([
    { dia: '2026-08-17', fit_distance: 12.5, fit_duration: '1:15:00' },
    { dia: '2026-08-20', fit_distance: 7, fit_duration: '40:00' },
    { dia: '2026-08-23', fit_distance: -3, fit_duration: '60:00' },
    { dia: '2026-08-23', fit_distance: 'junk', fit_duration: '' },
    null,
  ]);
  assert.equal(totals.distanceKm, 19.5, 'negative and malformed distances are ignored');
  assert.equal(totals.durationSeconds, 10500, 'empty durations contribute nothing');
  assert.deepEqual(accumulateWeeklyMetrics(null), { distanceKm: 0, durationSeconds: 0 });
  assert.deepEqual(accumulateWeeklyMetrics([]), { distanceKm: 0, durationSeconds: 0 });
});

test('accumulateWeeklyMetrics maps API FIT fields into visible weekly totals', () => {
  const totals = accumulateWeeklyMetrics([
    { dia: '2026-08-23', fit_distance: '10', fit_duration: 3720 },
  ]);

  assert.deepEqual(totals, { distanceKm: 10, durationSeconds: 3720 });
  assert.deepEqual(metricsCardContent(totals), {
    distance: '10.00 km',
    time: '1h 02m',
  });
});

test('formatters render distances and durations in the agreed dashboard units', () => {
  assert.equal(formatDistanceKm(0), '0.00 km');
  assert.equal(formatDistanceKm(15.034), '15.03 km');
  assert.equal(formatDistanceKm(null), '0.00 km');
  assert.equal(formatDuration(0), '0h 00m');
  assert.equal(formatDuration(60), '0h 01m');
  assert.equal(formatDuration(90), '0h 02m');
  assert.equal(formatDuration(3600), '1h 00m');
  assert.equal(formatDuration(4860), '1h 21m');
  assert.equal(formatDuration(86340), '23h 59m');
});

// ── Cycle math ─────────────────────────────────────────────────

test('parseIsoDate accepts clean dates and rejects junk', () => {
  assert.equal(parseIsoDate('2026-08-17').getDate(), 17);
  assert.equal(parseIsoDate('2026-08-17').getMonth(), 7);
  assert.equal(parseIsoDate(null), null);
  assert.equal(parseIsoDate('17-08-2026'), null);
  assert.equal(parseIsoDate('2026-13-40'), null);
});

test('weeksBetween rounds partial weeks up and clamps to at least one', () => {
  assert.equal(weeksBetween('2026-08-17', '2026-08-23'), 1);
  assert.equal(weeksBetween('2026-08-17', '2026-08-30'), 2);
  assert.equal(weeksBetween('2026-08-17', '2026-08-25'), 2, '8 days is two calendar weeks');
  assert.equal(weeksBetween('2026-08-17', '2026-08-17'), 1);
  assert.equal(weeksBetween('2026-08-25', '2026-08-17'), 1, 'reversed dates clamp to one week');
  assert.equal(weeksBetween(null, '2026-08-17'), null);
});

test('currentWeekNumber counts from the cycle start, never dropping below one', () => {
  assert.equal(currentWeekNumber('2026-08-17', new Date(2026, 7, 17)), 1);
  assert.equal(currentWeekNumber('2026-08-17', new Date(2026, 7, 23)), 1);
  assert.equal(currentWeekNumber('2026-08-17', new Date(2026, 7, 24)), 2);
  assert.equal(currentWeekNumber('2026-08-17', new Date(2026, 7, 10)), 1, 'before start is week one');
  assert.equal(currentWeekNumber(null, new Date(2026, 7, 24)), null);
  assert.equal(currentWeekNumber('2026-08-17', new Date(2026, 6, 24)), 1);
});

test('cycleProgress yields week number, total weeks and a clamped percent', () => {
  const today = new Date(2026, 7, 24);
  assert.deepEqual(
    cycleProgress({ start_date: '2026-08-17', target_date: '2026-09-06' }, today),
    { current: 2, total: 3, percent: 67 }
  );
  assert.equal(
    cycleProgress({ start_date: '2026-08-17', target_date: '2026-09-06' }, new Date(2026, 7, 17)).percent,
    33
  );
  const overrun = cycleProgress({ start_date: '2026-08-17', target_date: '2026-09-06' }, new Date(2026, 8, 14));
  assert.deepEqual(overrun, { current: 3, total: 3, percent: 100 }, 'past the target the ring clamps');
  const openEnded = cycleProgress({ start_date: '2026-08-17' }, today);
  assert.deepEqual(openEnded, { current: 2, total: null, percent: null });
  assert.equal(cycleProgress(null, today), null);
  assert.equal(cycleProgress({}, today), null);
});

test('cycleWeekText localizes week progress and falls back to week-only for open-ended cycles', () => {
  assert.equal(
    cycleWeekText(en, { current: 2, total: 3 }),
    'Week 2 of 3'
  );
  assert.equal(
    cycleWeekText(pt, { current: 2, total: 3 }),
    'Semana 2 de 3'
  );
  assert.equal(cycleWeekText(en, { current: 2, total: null }), 'Week 2');
  assert.equal(cycleWeekText(en, {}), '');
});

test('cycleCardContent maps a cycle into dashboard card data in the active language', () => {
  const content = cycleCardContent(
    {
      start_date: '2026-08-17',
      target_date: '2026-09-06',
      objective: 'Base phase · 60km',
      primary_goal: 'Maintain consistent weekly volume',
      secondary_goal: 'Finish every planned run',
      distance: 60,
    },
    en,
    new Date(2026, 7, 24)
  );
  assert.equal(content.name, 'Base phase · 60km');
  assert.equal(content.objective, 'Maintain consistent weekly volume');
  assert.equal(content.targetDate, '2026-09-06');
  assert.equal(content.targetDisplay, '2026-09-06', 'English keeps the ISO sortable date');
  assert.equal(content.daysRemaining, 13, 'the countdown bridges the current date to the target');
  assert.equal(content.daysRemainingText, '13 days remaining');
  assert.equal(content.weekText, 'Week 2 of 3');
  assert.equal(content.percent, 67);
  assert.equal(content.hasProgress, true);
  assert.equal(cycleCardContent(null, en, new Date(2026, 7, 24)), null);
});

test('cycleCardContent maps the cycle name from "objective" and the goal from "primary_goal" independently', () => {
  const content = cycleCardContent(
    {
      start_date: '2026-08-17',
      target_date: '2026-09-13',
      objective: 'Maratona de Lisboa',
      primary_goal: 'Correr a Maratona abaixo de 3h30',
      distance: 120,
    },
    pt,
    new Date(2026, 8, 9)
  );
  assert.equal(content.name, 'Maratona de Lisboa', 'the title comes from the "Objetivo" field (objective)');
  assert.equal(content.objective, 'Correr a Maratona abaixo de 3h30', 'the subtitle comes from the "Meta principal" field (primary_goal)');
  assert.notEqual(content.name, content.objective, 'title and goal render independently');
});

test('cycleCardContent falls back to a distance-based name when the objective field is empty', () => {
  const unnamed = cycleCardContent({ target_date: '2026-09-13', distance: 60, primary_goal: 'Goal' }, en);
  assert.equal(unnamed.name, 60, 'name degrades to the distance value');
  assert.equal(unnamed.objective, 'Goal');
});

test('cycleCardContent formats the target date as dd/mm/yyyy for Portuguese', () => {
  const ptContent = cycleCardContent(
    {
      start_date: '2026-08-17',
      target_date: '2026-09-13',
      objective: 'Base',
      primary_goal: 'Manter o volume semanal',
    },
    pt,
    new Date(2026, 8, 9),
    'pt-BR'
  );
  assert.equal(ptContent.targetDisplay, '13/09/2026');
  assert.equal(ptContent.targetDate, '2026-09-13');
  assert.equal(ptContent.objective, 'Manter o volume semanal', 'the pt-BR goal rides along untouched');
  assert.equal(ptContent.daysRemaining, 4);
  assert.equal(ptContent.daysRemainingText, '4 dias restantes', 'the countdown pluralizes in pt');
});

test('formatTargetDate keeps ISO for English and day-first for every Portuguese variant', () => {
  assert.equal(formatTargetDate('2026-09-13', 'en-US'), '2026-09-13');
  assert.equal(formatTargetDate('2026-09-13', DEFAULT_DISPLAY_LANGUAGE), '2026-09-13');
  assert.equal(formatTargetDate('2026-09-13', 'pt-BR'), '13/09/2026');
  assert.equal(formatTargetDate('2026-09-13', 'pt'), '13/09/2026');
  assert.equal(formatTargetDate('2026-01-02', 'pt-BR'), '02/01/2026', 'month and day are zero-padded');
  assert.equal(formatTargetDate('junk', 'pt-BR'), '');
  assert.equal(formatTargetDate(null, 'pt-BR'), '');
});

test('daysRemainingUntil counts whole days between today and the target', () => {
  assert.equal(daysRemainingUntil('2026-09-13', new Date(2026, 8, 9)), 4);
  assert.equal(daysRemainingUntil('2026-09-13', new Date(2026, 8, 10)), 3);
  assert.equal(daysRemainingUntil('2026-09-13', new Date(2026, 8, 13)), 0, 'target day counts as today');
  assert.equal(daysRemainingUntil('2026-09-13', new Date(2026, 8, 14)), -1, 'past targets stay negative for the "ended" label');
  assert.equal(daysRemainingUntil(null), null);
  assert.equal(daysRemainingUntil('junk'), null);
});

test('daysRemainingText pluralizes and handles today and ended states', () => {
  assert.equal(daysRemainingText(pt, 9), '9 dias restantes');
  assert.equal(daysRemainingText(en, 9), '9 days remaining');
  assert.equal(daysRemainingText(pt, 1), '1 dia restante');
  assert.equal(daysRemainingText(en, 1), '1 day remaining');
  assert.equal(daysRemainingText(pt, 0), 'Hoje');
  assert.equal(daysRemainingText(en, 0), 'Today');
  assert.equal(daysRemainingText(pt, -3), 'Encerrado');
  assert.equal(daysRemainingText(en, -3), 'Ended');
  assert.equal(daysRemainingText(en, null), '');
  assert.equal(daysRemainingText(en, undefined), '');
});

test('metricsCardContent formats the dashboard totals', () => {
  assert.deepEqual(metricsCardContent({ distanceKm: 19.5, durationSeconds: 8100 }), {
    distance: '19.50 km',
    time: '2h 15m',
  });
  assert.deepEqual(metricsCardContent({}), { distance: '0.00 km', time: '0h 00m' });
  assert.deepEqual(metricsCardContent(null), { distance: '0.00 km', time: '0h 00m' });
});

// ── Weekly 7-day tracker ───────────────────────────────────────

const WEEK = { start: '2026-08-17', end: '2026-08-23' };

test('weekDays expands a Monday-to-Sunday window into seven dated cells', () => {
  const days = weekDays(WEEK);
  assert.equal(days.length, 7);
  assert.deepEqual(
    days.map((day) => day.date),
    ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23']
  );
  assert.deepEqual(days.map((day) => day.key), WEEKDAY_KEYS);
  assert.equal(days[0].date, '2026-08-17');
  assert.equal(days[6].date, '2026-08-23');
  assert.deepEqual(weekDays(null), []);
  assert.deepEqual(weekDays({}), []);
  assert.deepEqual(weekDays({ start: 'nope' }), []);
});

test('trainingDaySet collects only well-formed workout dates', () => {
  const set = trainingDaySet([
    { dia: '2026-08-19' },
    { dia: '2026-08-21' },
    { dia: '2026-08-19' },
    { dia: '' },
    { dia: null },
    null,
    'junk',
  ]);
  assert.ok(set.has('2026-08-19'));
  assert.ok(set.has('2026-08-21'));
  assert.equal(set.size, 2, 'duplicates collapse into a single set entry');
  assert.equal(trainingDaySet(null).size, 0);
});

test('weekDayState marks exactly the days whose ISO date has a training', () => {
  const states = weekDayState(weekDays(WEEK), new Set(['2026-08-19', '2026-08-21']));
  assert.deepEqual(
    states.map((day) => day.hasTraining),
    [false, false, true, false, true, false, false]
  );
  const none = weekDayState(weekDays(WEEK), trainingDaySet([]));
  assert.equal(none.every((day) => day.hasTraining === false), true);
  const allEmptySet = weekDayState(weekDays(WEEK), new Set());
  assert.equal(allEmptySet.some((day) => day.hasTraining), false);
});

test('buildWeekDayMarkup maps training state to the visual and i18n classes', () => {
  const active = buildWeekDayMarkup({ date: '2026-08-19', key: 'home.days.wed', hasTraining: true }, pt);
  assert.equal(active.cls, 'week-day has-training');
  assert.equal(active.label, 'Qua');
  assert.equal(active.dataI18n, 'home.days.wed');
  assert.equal(active.icon, 'sport-shoe');
  const idle = buildWeekDayMarkup({ date: '2026-08-17', key: 'home.days.mon', hasTraining: false }, en);
  assert.equal(idle.cls, 'week-day empty');
  assert.equal(idle.label, 'Mon');
  assert.equal(idle.icon, null);
});

// ── DOM side-effects (hand-rolled runtime) ─────────────────────

function fakeDocument() {
  const realDocument = globalThis.document;
  const makeEl = () => ({
    className: '',
    textContent: '',
    attrs: {},
    children: [],
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
      this.textContent += child.textContent;
      return child;
    },
  });
  const container = makeEl();
  globalThis.document = { createElement: () => makeEl() };
  return {
    container,
    makeEl,
    destroy: () => {
      globalThis.document = realDocument;
    },
  };
}

test('renderWeekDays renders an all-empty Monday-to-Sunday week when no training exists', () => {
  const dom = fakeDocument();
  try {
    const states = weekDayState(weekDays(WEEK), new Set());
    renderWeekDays(dom.container, states, en);
    assert.equal(dom.container.children.length, 7);
    for (const cell of dom.container.children) {
      assert.equal(cell.className, 'week-day empty');
      assert.equal(cell.children.some((child) => child.attrs['data-lucide'] === 'sport-shoe'), false);
      assert.equal(cell.children[0].attrs['data-i18n'].startsWith('home.days.'), true);
    }
    assert.deepEqual(
      dom.container.children.map((cell) => cell.textContent),
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    );
  } finally {
    dom.destroy();
  }
});

test('renderWeekDays flags exactly Wednesday and Friday as having trainings', () => {
  const dom = fakeDocument();
  try {
    const states = weekDayState(weekDays(WEEK), new Set(['2026-08-19', '2026-08-21']));
    renderWeekDays(dom.container, states, pt);
    const classes = dom.container.children.map((cell) => cell.className);
    assert.deepEqual(classes, [
      'week-day empty',
      'week-day empty',
      'week-day has-training',
      'week-day empty',
      'week-day has-training',
      'week-day empty',
      'week-day empty',
    ]);
    assert.equal(dom.container.children[2].textContent, 'Qua', 'Wednesday maps to its PT label');
    assert.equal(dom.container.children[4].textContent, 'Sex', 'Friday maps to its PT label');
    assert.equal(dom.container.children[2].children[0].attrs['data-lucide'], 'sport-shoe');
    assert.equal(dom.container.children[4].children[0].attrs['data-lucide'], 'sport-shoe');
    assert.equal(dom.container.children[2].children[0].attrs['aria-hidden'], 'true');
    assert.equal(dom.container.children[2].attrs['aria-label'], '2026-08-19', 'cells carry their ISO date');
  } finally {
    dom.destroy();
  }
});

test('renderWeekDays guards against missing containers and non-array states', () => {
  const dom = fakeDocument();
  try {
    renderWeekDays(null, weekDayState(weekDays(WEEK), new Set()), en);
    renderWeekDays(dom.container, 'not-an-array', en);
    assert.equal(dom.container.children.length, 0, 'no cells render on invalid input');
  } finally {
    dom.destroy();
  }
});

// ── Quote loading (fetch + timeout + fallback) ─────────────────

test('randomFallbackQuote picks a deterministic quote from the active dictionary', () => {
  const first = randomFallbackQuote(en, () => 0);
  const last = randomFallbackQuote(en, () => 0.999);
  assert.equal(first, en.home.hero.fallbackQuotes[0]);
  assert.equal(last, en.home.hero.fallbackQuotes[en.home.hero.fallbackQuotes.length - 1]);
  const over = randomFallbackQuote(en, () => 5);
  assert.equal(over, en.home.hero.fallbackQuotes[en.home.hero.fallbackQuotes.length - 1]);
  assert.equal(randomFallbackQuote({}, () => 0), null);
});

test('normalizeZenQuote extracts text and author from both payload shapes', () => {
  assert.deepEqual(normalizeZenQuote([{ q: '  Run today.  ', a: '  Coach  ' }]), {
    text: 'Run today.',
    author: 'Coach',
  });
  assert.deepEqual(normalizeZenQuote({ q: 'Go', a: 'ZenQuotes' }), { text: 'Go', author: 'ZenQuotes' });
  assert.equal(normalizeZenQuote(null), null);
  assert.equal(normalizeZenQuote({}), null);
  assert.equal(normalizeZenQuote([{ q: '' }]), null);
  assert.equal(normalizeZenQuote('junk'), null);
});

test('loadQuote resolves the API quote and tags it as coming from the API', async () => {
  const quote = await loadQuote({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ q: 'Run today.', a: 'Coach' }],
    }),
  });
  assert.deepEqual(quote, { text: 'Run today.', author: 'Coach', source: 'api' });
  assert.match(ZENQUOTES_URL, /^https:\/\/zenquotes\.io\//);
});

test('loadQuote falls back to the local dictionary on network errors and bad payloads', async () => {
  const options = { messages: en, random: () => 0 };
  const network = await loadQuote({
    ...options,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(network.source, 'fallback');
  assert.equal(network.text, en.home.hero.fallbackQuotes[0].text);

  const badStatus = await loadQuote({
    ...options,
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  assert.equal(badStatus.source, 'fallback');

  const junk = await loadQuote({
    ...options,
    fetchImpl: async () => ({ ok: true, json: async () => ({ z: 1 }) }),
  });
  assert.equal(junk.source, 'fallback');
});

test('loadQuote with no fallback quotes resolves to null without throwing', async () => {
  const result = await loadQuote({
    messages: {},
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(result, null);
});

test('loadQuote aborts the ZenQuotes request after the timeout and falls back', async () => {
  assert.equal(QUOTE_TIMEOUT_MS, 3000);
  const fetchImpl = (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  const quote = await loadQuote({ fetchImpl, messages: en, random: () => 0.5, timeoutMs: 5 });
  assert.equal(quote.source, 'fallback');
  assert.equal(quote.text, en.home.hero.fallbackQuotes[Math.floor(0.5 * en.home.hero.fallbackQuotes.length)].text);
});

// ── DOM side-effects (hand-rolled runtime) ─────────────────────

test('applyHeroImage sets the CSS var used by the dark overlay hero', () => {
  const banner = {
    style: {
      values: {},
      setProperty(name, value) {
        this.values[name] = value;
      },
    },
  };
  applyHeroImage(banner, 'https://example.com/stage.jpg');
  assert.equal(banner.style.values['--hero-image'], 'url("https://example.com/stage.jpg")');
  applyHeroImage(null, 'https://example.com/stage.jpg');
  applyHeroImage(banner, null);
  applyHeroImage(banner, 42);
  assert.equal(banner.style.values['--hero-image'], 'url("https://example.com/stage.jpg")');
});

function fakeCycleEl() {
  const classes = new Set();
  return {
    attrs: {},
    style: {},
    classList: {
      has: (name) => classes.has(name),
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
        return classes.has(name);
      },
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
  };
}

test('applyCycleVisibility hides the empty state when an active cycle exists', () => {
  const emptyContainer = fakeCycleEl();
  const activeContainer = fakeCycleEl();

  applyCycleVisibility({ emptyContainer, activeContainer }, true);

  assert.equal(emptyContainer.classList.has('hidden'), true, 'the empty card gains the hidden class');
  assert.equal(emptyContainer.style.display, 'none', 'the empty card is display:none');
  assert.equal(emptyContainer.attrs['aria-hidden'], 'true');
  assert.equal(activeContainer.classList.has('hidden'), false, 'the active card is revealed');
  assert.equal(activeContainer.style.display, '', 'the active card returns to its natural display');
  assert.equal(activeContainer.attrs['aria-hidden'], 'false');
});

test('applyCycleVisibility hides the active card and reveals the empty state without a cycle', () => {
  const emptyContainer = fakeCycleEl();
  const activeContainer = fakeCycleEl();

  applyCycleVisibility({ emptyContainer, activeContainer }, false);

  assert.equal(activeContainer.classList.has('hidden'), true);
  assert.equal(activeContainer.style.display, 'none');
  assert.equal(activeContainer.attrs['aria-hidden'], 'true');
  assert.equal(emptyContainer.classList.has('hidden'), false);
  assert.equal(emptyContainer.style.display, '');
  assert.equal(emptyContainer.attrs['aria-hidden'], 'false');
});

test('applyCycleVisibility flips cleanly between states without leaving stale visibility', () => {
  const emptyContainer = fakeCycleEl();
  const activeContainer = fakeCycleEl();

  applyCycleVisibility({ emptyContainer, activeContainer }, true);
  applyCycleVisibility({ emptyContainer, activeContainer }, false);
  applyCycleVisibility({ emptyContainer, activeContainer }, true);

  assert.equal(emptyContainer.classList.has('hidden'), true, 'empty is hidden on the final active render');
  assert.equal(emptyContainer.style.display, 'none');
  assert.equal(activeContainer.classList.has('hidden'), false, 'active is the only visible state');
  assert.equal(activeContainer.style.display, '');
});

test('applyCycleVisibility tolerates missing containers without throwing', () => {
  assert.doesNotThrow(() => applyCycleVisibility({ emptyContainer: null, activeContainer: null }, true));
  assert.doesNotThrow(() => applyCycleVisibility({}, false));
  assert.doesNotThrow(() => applyCycleVisibility(null, true));
});

// ── JS source invariants ───────────────────────────────────────

test('home.js keeps the dashboard wiring declarative and reactive', () => {
  const js = readHomeJs();
  assert.match(js, /import \{ fetchActiveCycle, fetchCalendarTrainings \} from '\.\/shared\/api\.js'/);
  assert.match(js, /import \{ initShell, getShellI18n \} from '\.\/shared\/shell\.js'/);
  assert.match(js, /initShell\(\{ active: 'dashboard' \}\)/);
  assert.match(js, /new AbortController\(\)/);
  assert.match(js, /setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/);
  assert.match(js, /'app:languagechange'/);
  assert.match(js, /setProperty\('--hero-image'/);
  assert.match(js, /fetchCalendarTrainings\(range\.start, range\.end\)/);
  assert.match(
    js,
    /loadQuote\(\{ messages: i18n \? i18n\.messages : \{\} \}\)/,
    'the quote lookup resolves messages inside the call, never at module scope'
  );
  assert.match(
    js,
    /document\.addEventListener\('app:languagechange',\s*\(\) => \{\s*\n\s*render\(\);/,
    'the language switch re-renders the cycle, metrics and week labels'
  );
  assert.match(js, /renderWeekTracker\(\);/);
  assert.match(js, /state\.trainingDates = trainingDaySet\(weekTrainings\)/);
  assert.match(js, /export function applyCycleVisibility/);
  assert.match(
    js,
    /applyCycleVisibility\(\{ emptyContainer: cycleEmpty, activeContainer: cycleActive \}, hasCycle\)/,
    'the cycle renderer funnels both sibling states through the exclusive visibility helper'
  );
  assert.match(
    js,
    /const language = i18n \? i18n\.language : DEFAULT_DISPLAY_LANGUAGE;/,
    'the active language drives the target-date formatting and countdown'
  );
  assert.match(js, /if \(cycleName\) cycleName\.textContent = content\.name;/);
  assert.match(js, /cycleObjective\.textContent = cycleObjectiveText\(messages, content\.objective\);/);
  assert.match(js, /cycleObjective\.classList\.add\('hidden'\);/);
  assert.equal(
    /content\.objective !== content\.name/.test(js),
    false,
    'the subtitle no longer echoes the title; the goal renders independently'
  );
  assert.match(js, /if \(cycleDaysLeft\) cycleDaysLeft\.textContent = content\.daysRemainingText;/);
  assert.match(js, /if \(cycleTarget\) cycleTarget\.textContent = content\.targetDisplay;/);
  assert.match(
    js,
    /export function daysRemainingText\(messages, days\)/,
    'the countdown label helper stays exported for unit testing'
  );
});

test('home.css lays out the cycle header, objective subtitle and compact progress spacing', () => {
  const css = readHomeCss();
  assert.match(
    css,
    /\.cycle-card \.cycle-header \{[^}]*display:\s*flex;\s*\n\s*align-items:\s*center;\s*\n\s*justify-content:\s*space-between/,
    'the header row pinches the countdown chip to the right side'
  );
  assert.match(
    css,
    /\.cycle-card \.cycle-week \{[^}]*margin:\s*0 0 0\.3rem;/,
    'the week progress text hugs the progress bar below it'
  );
  assert.match(
    css,
    /\.cycle-card \.cycle-objective \{[^}]*color:\s*var\(--muted\);/,
    'the objective renders as a muted subtitle beneath the name'
  );
  assert.match(
    css,
    /\.cycle-card \.cycle-objective \{[^}]*margin:\s*0 0 0\.25rem;/,
    'the objective keeps a compact gap before the target metadata'
  );
  assert.match(
    css,
    /\.cycle-card \.cycle-target \{[^}]*margin:\s*0 0 0\.25rem;/,
    'the target metadata keeps compact spacing before progress details'
  );
  assert.match(css, /\.cycle-card \.days-left \{[^}]*white-space:\s*nowrap/);
});

test('home.css stacks the dashboard widgets full-width and styles the week tracker', () => {
  const css = readHomeCss();
  assert.match(css, /\.hero-loading \{[^}]*display:\s*table[^}]*padding:\s*0\.45rem 0\.7rem[^}]*background-color:\s*rgba\(0, 0, 0, 0\.6\)/);
  assert.match(css, /\.hero-quote p \{[^}]*display:\s*table[^}]*padding:\s*0\.45rem 0\.7rem[^}]*background-color:\s*rgba\(0, 0, 0, 0\.6\)/);
  assert.match(css, /\.hero-quote-author \{[^}]*display:\s*table[^}]*background-color:\s*rgba\(0, 0, 0, 0\.6\)/);
  assert.match(css, /@import url\('\.\/shared\/theme\.css'\)/);
  assert.match(css, /linear-gradient\(rgba\(0, 0, 0, 0\.5\), rgba\(0, 0, 0, 0\.5\)\)/);
  assert.match(css, /var\(--hero-image/);
  assert.match(css, /var\(--accent-deep\)/);
  assert.match(css, /var\(--bg\)/);
  assert.match(
    css,
    /\.dashboard-grid \{[^}]*display:\s*flex;\s*\n\s*flex-direction:\s*column/,
    'the widget container stacks vertically'
  );
  assert.match(
    css,
    /\.dashboard-grid \.card-section \{[^}]*width:\s*100%/,
    'each widget card stretches to the full container width'
  );
  const dashboardBlock = css.match(/\.dashboard-grid \{([^}]*)\}/);
  assert.ok(dashboardBlock, 'the dashboard-grid rule exists');
  assert.ok(
    !dashboardBlock[1].includes('grid-template-columns'),
    'the widget container no longer uses a grid column layout'
  );
  assert.match(
    css,
    /\.metrics-grid \{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
    'the distance/time tiles keep their two-up layout inside the full-width card'
  );
  assert.match(css, /\.week-tracker \{[^}]*border-bottom:\s*1px solid var\(--line\)/);
  assert.match(css, /\.section-header \{[^}]*display:\s*flex/);
  assert.match(css, /\.card-action \{[^}]*display:\s*inline-flex[^}]*color:\s*var\(--accent-deep\)/);
  assert.match(css, /\.week-tracker \{[^}]*margin:\s*0 0 1rem/);
  assert.match(
    css,
    /\.card-section\[aria-labelledby="weeklyMetricsTitle"\] \.section-header \{[^}]*margin-bottom:\s*0\.65rem/,
    'the tracker sits close beneath the This Week heading'
  );
  assert.match(css, /\.week-tracker-days \{[^}]*display:\s*flex/);
  assert.match(css, /\.week-tracker-days \{[^}]*align-items:\s*center/);
  assert.match(css, /\.week-day \{[^}]*border:\s*0;[^}]*border-radius:\s*999px/);
  assert.match(css, /\.week-day\.has-training \{[^}]*background:\s*var\(--accent-deep\)/);
  assert.match(css, /\.week-day\.has-training \{[^}]*gap:\s*0\.5rem/);
  assert.match(css, /\.week-day svg \{[^}]*display:\s*inline-block/);
  assert.doesNotMatch(css, /\.week-day svg \{[^}]*transform:\s*rotate\(180deg\)/);
  assert.match(css, /\.week-day\.empty \{[^}]*background:\s*transparent;[^}]*color:\s*var\(--muted\)/);
});
