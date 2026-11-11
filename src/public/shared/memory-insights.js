// Presentation-only insights for the training memory page. Every value is
// derived from the projection the page already received (the same selection an
// AI task sends); nothing here selects, stores or sends data.

const DAY_MS = 86400000;

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function mondayOf(iso) {
  const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((weekday + 6) % 7));
}

// "h:mm:ss" or "mm:ss" to seconds; anything else is unknown.
export function durationSeconds(value) {
  if (typeof value !== 'string' || !/^\d+(?::[0-5]\d){1,2}$/.test(value)) return null;
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

// Weekly series ending with the week of `asOf`: older weeks come from the
// selected weekly totals, the detailed weeks from the selected recent sessions.
export function weeklySeries(memory, weeks = 6) {
  const byWeek = new Map();
  const ensure = (weekStart) => {
    if (!byWeek.has(weekStart))
      byWeek.set(weekStart, { weekStart, distanceKm: 0, durationSeconds: 0, completed: 0, planned: 0, rpeSum: 0, rpeCount: 0 });
    return byWeek.get(weekStart);
  };
  for (const row of memory.weekly || []) {
    const week = ensure(row.weekStart);
    week.distanceKm += row.distanceKm || 0;
    week.durationSeconds += row.durationSeconds || 0;
    week.completed += row.completed || 0;
    week.planned += row.planned || 0;
    // Weighted by the number of RPE reports, never by sessions without one.
    if (Number.isFinite(row.averageRpe) && row.rpeReports > 0) {
      week.rpeSum += row.averageRpe * row.rpeReports;
      week.rpeCount += row.rpeReports;
    }
  }
  const sessions = [...(memory.recent || [])];
  // The analyzed session is a reference; it only counts if the totals do not already hold it.
  if (memory.task?.session && !memory.task.session.includedInAggregates) sessions.push(memory.task.session);
  for (const session of sessions) {
    if (session.date > memory.asOf) continue;
    const week = ensure(mondayOf(session.date));
    week.planned += 1;
    if (!session.actual?.completed) continue;
    week.completed += 1;
    if (Number.isFinite(session.actual.fit_distance)) week.distanceKm += session.actual.fit_distance;
    const seconds = durationSeconds(session.actual.fit_duration);
    if (seconds !== null) week.durationSeconds += seconds;
    if (Number.isInteger(session.report?.feedback_rpe)) {
      week.rpeSum += session.report.feedback_rpe;
      week.rpeCount += 1;
    }
  }
  const current = mondayOf(memory.asOf);
  return Array.from({ length: weeks }, (_, index) => {
    const weekStart = addDays(current, (index - weeks + 1) * 7);
    const week = byWeek.get(weekStart) || { weekStart, distanceKm: 0, durationSeconds: 0, completed: 0, planned: 0, rpeSum: 0, rpeCount: 0 };
    return {
      weekStart,
      distanceKm: Math.round(week.distanceKm * 100) / 100,
      durationSeconds: week.durationSeconds,
      completed: week.completed,
      planned: week.planned,
      averageRpe: week.rpeCount ? week.rpeSum / week.rpeCount : null,
      rpeReports: week.rpeCount,
    };
  });
}

function averageRpe(weeks) {
  let sum = 0; let count = 0;
  for (const week of weeks) if (week.averageRpe !== null) { sum += week.averageRpe * week.rpeReports; count += week.rpeReports; }
  return count ? sum / count : null;
}

// The four headline numbers. `partial` marks a summary built from a selection
// that had to leave recent sessions or weekly totals out: those weeks are
// unknown, not zero.
export function memorySummary(memory) {
  const series = weeklySeries(memory, 6);
  const lastFour = series.slice(-4);
  const planned = lastFour.reduce((sum, week) => sum + week.planned, 0);
  const completed = lastFour.reduce((sum, week) => sum + week.completed, 0);
  const recentEffort = averageRpe(series.slice(-2));
  const previousEffort = averageRpe(series.slice(-4, -2));
  let trend = null;
  if (recentEffort !== null && previousEffort !== null) {
    const delta = recentEffort - previousEffort;
    trend = Math.abs(delta) < 0.25 ? 'flat' : delta > 0 ? 'up' : 'down';
  }
  const concerns = [...(memory.recent || []), ...(memory.task?.session ? [memory.task.session] : [])]
    .filter((session) => session.priority === 'concern')
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    series,
    volume: { distanceKm: Math.round(lastFour.reduce((sum, week) => sum + week.distanceKm, 0) * 100) / 100 },
    consistency: { completed, planned, ratio: planned ? completed / planned : null },
    effort: { recent: recentEffort, previous: previousEffort, trend },
    concerns: { count: concerns.length, latest: concerns[0] ?? null },
    partial: Boolean(memory.omissions?.budget?.recent || memory.omissions?.budget?.weekly),
  };
}

// Actionable checklist of what helps the AI. Each item is ok or carries the
// number of records to fix and a link to where they are fixed.
export function memoryQuality(memory) {
  const items = [];
  const configured = memory.availability || [];
  const needsReview = configured.some((day) => day.canTrain && (day.periods.length !== 1 || day.minutes == null || !day.location));
  items.push({ key: 'availability', ok: configured.length === 7 && !needsReview, href: '/ai-coach.html' });
  items.push({ key: 'cycle', ok: Boolean(memory.cycle), href: '/cycles.html' });
  const sessions = [...(memory.recent || [])].filter((session) => session.date <= memory.asOf);
  const withoutEffort = sessions.filter((session) => session.actual?.completed && !Number.isInteger(session.report?.feedback_rpe));
  items.push({ key: 'effort', ok: !withoutEffort.length, count: withoutEffort.length, href: withoutEffort[0]?.href ?? '/calendar.html' });
  const withoutResult = sessions.filter((session) => !session.actual?.completed && session.date < memory.asOf);
  items.push({ key: 'results', ok: !withoutResult.length, count: withoutResult.length, href: withoutResult[0]?.href ?? '/calendar.html' });
  items.push({ key: 'experience', ok: Boolean(memory.profile?.fields?.experience?.value), href: '#experience' });
  if (memory.purpose !== 'cycle') {
    const plan = memory.appliedPlan;
    const state = !plan ? 'none' : plan.compatibilityError ? 'incompatible' : plan.outdated ? 'outdated' : 'current';
    items.push({ key: 'plan', ok: state === 'current', state, href: '/cycles.html' });
  }
  return items;
}
