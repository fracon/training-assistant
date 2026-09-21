'use strict';

const DefaultFitParser = require('fit-file-parser').default;

const DEFAULT_PARSER_OPTIONS = {
  force: false,
  speedUnit: 'km/h',
  lengthUnit: 'm',
  mode: 'list',
};

const PARSE_TIMEOUT_MS = 10000;

function pickNumber(source, key) {
  return Number.isFinite(source?.[key]) ? source[key] : null;
}

function pickNumberAny(source, keys) {
  for (const key of keys) {
    const value = pickNumber(source, key);
    if (value !== null) return value;
  }
  return null;
}

function nonNegativeNumber(source, key) {
  const value = pickNumber(source, key);
  return value !== null && value >= 0 ? value : null;
}

function positiveNumber(source, key) {
  const value = pickNumber(source, key);
  return value !== null && value > 0 ? value : null;
}

function normalizeCalories(value) {
  if (value === null || value === undefined || value === '') return null;
  const calories = Number(value);
  if (!Number.isFinite(calories) || calories < 0) return null;
  return Math.round(calories);
}

function round(value, decimals) {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return '--:--';
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatPace(secondsPerKm) {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return '--:--';
  const total = Math.round(secondsPerKm);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDistance(distanceKm) {
  return distanceKm === null ? '-' : distanceKm.toFixed(2);
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveStepType(lap) {
  const raw = `${lap.intensity ?? ''} ${lap.sub_sport ?? ''}`.toLowerCase();
  if (raw.includes('warm')) return 'Warmup';
  if (raw.includes('cool')) return 'Cooldown';
  if (raw.includes('rest') || raw.includes('recover')) return 'Rest';
  return 'Run';
}

function buildLapView(lap, index, cumulativeBefore) {
  const timerDuration = nonNegativeNumber(lap, 'total_timer_time');
  const elapsedDuration = nonNegativeNumber(lap, 'total_elapsed_time');
  const duration = timerDuration > 0
    ? timerDuration
    : elapsedDuration > 0
      ? elapsedDuration
      : timerDuration ?? elapsedDuration;
  const distanceMeters = nonNegativeNumber(lap, 'total_distance');
  const distanceKm = distanceMeters === null ? null : distanceMeters / 1000;
  const maxSpeedKmh = pickNumber(lap, 'max_speed');
  const avgPace =
    duration !== null && duration > 0 && distanceKm !== null && distanceKm > 0
      ? duration / distanceKm
      : null;
  const bestPace =
    maxSpeedKmh !== null && maxSpeedKmh > 0 ? 3600 / maxSpeedKmh : null;
  const cumulativeAfter = cumulativeBefore + (duration ?? 0);
  return {
    stepType: resolveStepType(lap),
    lap: index + 1,
    duration,
    durationLabel: formatDuration(duration),
    cumulativeSeconds: round(cumulativeAfter, 2),
    cumulativeLabel: formatDuration(cumulativeAfter),
    distanceKm: distanceKm === null ? null : round(distanceKm, 3),
    distanceLabel: formatDistance(distanceKm),
    avgPaceSecondsPerKm: avgPace === null ? null : round(avgPace, 1),
    avgPaceLabel: formatPace(avgPace),
    bestPaceSecondsPerKm: bestPace === null ? null : round(bestPace, 1),
    bestPaceLabel: formatPace(bestPace),
    avgHeartRate: pickNumber(lap, 'avg_heart_rate'),
    maxHeartRate: pickNumber(lap, 'max_heart_rate'),
    ascentMeters: nonNegativeNumber(lap, 'total_ascent'),
    descentMeters: nonNegativeNumber(lap, 'total_descent'),
    avgCadenceSpm: pickNumberAny(lap, ['avg_running_cadence', 'avg_cadence']),
    maxCadenceSpm: pickNumberAny(lap, ['max_running_cadence', 'max_cadence']),
    strideMeters: pickNumber(lap, 'avg_stride_length'),
    calories: pickNumber(lap, 'total_calories'),
  };
}

function consistentLapTotals(laps) {
  if (laps.length === 0) return null;
  if (!laps.every((lap) => nonNegativeNumber(lap, 'total_distance') !== null)) return null;
  const distanceMeters = laps.reduce((sum, lap) => sum + nonNegativeNumber(lap, 'total_distance'), 0);
  if (!Number.isFinite(distanceMeters)) return null;

  for (const durationField of ['total_timer_time', 'total_elapsed_time']) {
    const lapDurations = laps.map((lap) => nonNegativeNumber(lap, durationField));
    if (lapDurations.some((duration) => duration === null)) continue;
    if (durationField === 'total_timer_time' && laps.some((lap, index) => (
      nonNegativeNumber(lap, 'total_distance') > 0 && lapDurations[index] === 0
    ))) continue;
    const durationSeconds = lapDurations.reduce((sum, duration) => sum + duration, 0);
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      return { durationSeconds, distanceKm: distanceMeters / 1000 };
    }
  }
  return null;
}

function timestampMilliseconds(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function recordDuration(records, events) {
  const recordTimes = records.map((record) => timestampMilliseconds(record?.timestamp))
    .filter((value) => value !== null);
  if (recordTimes.length < 2) return null;
  const end = Math.max(...recordTimes);
  const timerEvents = (Array.isArray(events) ? events : [])
    .filter((event) => event?.event === 'timer' && timestampMilliseconds(event.timestamp) !== null)
    .map((event) => ({ type: event.event_type, time: timestampMilliseconds(event.timestamp) }))
    .sort((a, b) => a.time - b.time);
  if (timerEvents.length === 0) {
    const elapsed = (end - Math.min(...recordTimes)) / 1000;
    return elapsed > 0 ? elapsed : null;
  }

  let startedAt = null;
  let total = 0;
  for (const event of timerEvents) {
    if (event.type === 'start' || event.type === 'resume') {
      if (startedAt === null) startedAt = event.time;
    } else if (['stop', 'stop_all', 'stop_disable', 'stop_disable_all'].includes(event.type) && startedAt !== null) {
      total += Math.max(0, event.time - startedAt);
      startedAt = null;
    }
  }
  if (startedAt !== null) total += Math.max(0, end - startedAt);
  const seconds = total / 1000;
  return seconds > 0 ? seconds : null;
}

function recordDistance(records) {
  let previous = null;
  let total = 0;
  let pairs = 0;
  for (const record of records) {
    const distance = nonNegativeNumber(record, 'distance');
    if (distance === null) {
      previous = null;
      continue;
    }
    if (previous !== null) {
      if (distance >= previous) {
        total += distance - previous;
        pairs += 1;
      }
    }
    previous = distance;
  }
  return pairs > 0 && total > 0 ? total / 1000 : null;
}

function recordAscent(records) {
  const field = records.some((record) => Number.isFinite(record?.enhanced_altitude))
    ? 'enhanced_altitude'
    : 'altitude';
  let previous = null;
  let ascent = 0;
  let pairs = 0;
  for (const record of records) {
    const altitude = pickNumber(record, field);
    if (altitude === null) {
      previous = null;
      continue;
    }
    if (previous !== null) {
      ascent += Math.max(0, altitude - previous);
      pairs += 1;
    }
    previous = altitude;
  }
  return pairs > 0 ? ascent : null;
}

function resolveActivityTotals(session, laps, records, events) {
  const sessionDistance = nonNegativeNumber(session, 'total_distance');
  const sessionTimer = positiveNumber(session, 'total_timer_time');
  const sessionElapsed = positiveNumber(session, 'total_elapsed_time');
  const sessionDuration = sessionTimer ?? sessionElapsed;
  if (sessionDistance !== null && sessionDuration !== null) {
    return { durationSeconds: sessionDuration, distanceKm: sessionDistance / 1000 };
  }
  const averageSpeed = positiveNumber(session, 'avg_speed');
  if (sessionDistance !== null && averageSpeed !== null) {
    return {
      durationSeconds: sessionDistance / (averageSpeed * 1000 / 3600),
      distanceKm: sessionDistance / 1000,
    };
  }
  const lapTotals = consistentLapTotals(laps);
  if (lapTotals) return lapTotals;
  const distanceKm = recordDistance(records);
  const durationSeconds = recordDuration(records, events);
  return distanceKm !== null && durationSeconds !== null
    ? { durationSeconds, distanceKm }
    : null;
}

function resolveAscent(session, laps, records) {
  const sessionAscent = nonNegativeNumber(session, 'total_ascent');
  if (sessionAscent !== null) return sessionAscent;
  if (laps.length > 0 && laps.every((lap) => nonNegativeNumber(lap, 'total_ascent') !== null)) {
    return laps.reduce((sum, lap) => sum + nonNegativeNumber(lap, 'total_ascent'), 0);
  }
  return recordAscent(records);
}

function buildTotals(views, calories = null, activity = null, ascentMeters = null) {
  let durationSeconds = 0;
  let hrWeighted = 0;
  let hrWeight = 0;
  const maxHeartRates = [];

  for (const view of views) {
    if (view.duration !== null) {
      durationSeconds += view.duration;
      if (view.avgHeartRate !== null && view.duration > 0) {
        hrWeighted += view.avgHeartRate * view.duration;
        hrWeight += view.duration;
      }
    }
    if (view.maxHeartRate !== null) maxHeartRates.push(view.maxHeartRate);
  }

  const duration = activity?.durationSeconds ?? durationSeconds;
  const preciseDistanceKm = activity?.distanceKm ?? null;
  const distanceKm = preciseDistanceKm === null ? null : round(preciseDistanceKm, 3);
  const avgPaceSecondsPerKm =
    preciseDistanceKm !== null && preciseDistanceKm > 0 && duration > 0
      ? round(duration / preciseDistanceKm, 1)
      : null;

  return {
    durationSeconds: round(duration, 2),
    durationLabel: formatDuration(duration),
    distanceKm,
    distanceLabel: formatDistance(distanceKm),
    avgPaceSecondsPerKm,
    avgPaceLabel: formatPace(avgPaceSecondsPerKm),
    avgHeartRate: hrWeight > 0 ? Math.round(hrWeighted / hrWeight) : null,
    maxHeartRate: maxHeartRates.length ? Math.max(...maxHeartRates) : null,
    ascentMeters: ascentMeters === null ? null : round(ascentMeters, 1),
    calories,
  };
}

function summarize(data) {
  const source = data ?? {};
  const session = source.sessions?.[0] ?? {};
  const sessionLaps = Array.isArray(session.laps) ? session.laps : [];
  const topLevelLaps = Array.isArray(source.laps) ? source.laps : [];
  const laps = sessionLaps.length ? sessionLaps : topLevelLaps;
  const records = Array.isArray(source.records) ? source.records : [];
  const events = Array.isArray(source.events) ? source.events : [];
  let cumulative = 0;
  const lapViews = laps.map((lap, index) => {
    const view = buildLapView(lap ?? {}, index, cumulative);
    cumulative = view.cumulativeSeconds;
    return view;
  });
  return {
    activity: {
      sport: session.sport ?? source.activity?.sport ?? null,
      startTime: toIso(session.start_time),
      endTime: toIso(session.timestamp),
    },
    laps: lapViews,
    // The session total is authoritative. Lap calories remain available in
    // each lap, but are not summed because exporters may report cumulative
    // values and doing so could double-count the activity.
    totals: buildTotals(
      lapViews,
      normalizeCalories(session.total_calories ?? session.totalCalories ?? session.calories),
      resolveActivityTotals(session, laps, records, events),
      resolveAscent(session, laps, records)
    ),
  };
}

async function parseFitFile(buffer, deps = {}) {
  const FitParserCtor = deps.FitParser || DefaultFitParser;
  const parser = new FitParserCtor(deps.options ?? DEFAULT_PARSER_OPTIONS);
  const timeoutMs = deps.timeoutMs ?? PARSE_TIMEOUT_MS;
  let timer;
  let raw;
  try {
    raw = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Timed out parsing the .FIT file.'));
      }, timeoutMs);
      parser.parse(buffer, (error, data) => {
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(data);
      });
    });
  } finally {
    clearTimeout(timer);
  }
  const summary = summarize(raw);
  if (!summary.laps.length) {
    throw new Error('No lap records found in .FIT file.');
  }
  return summary;
}

module.exports = {
  parseFitFile,
  summarize,
  resolveStepType,
  formatDuration,
  formatPace,
  formatDistance,
  normalizeCalories,
  resolveActivityTotals,
  resolveAscent,
};
