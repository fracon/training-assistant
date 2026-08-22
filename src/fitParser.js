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
  return Number.isFinite(source[key]) ? source[key] : null;
}

function pickNumberAny(source, keys) {
  for (const key of keys) {
    const value = pickNumber(source, key);
    if (value !== null) return value;
  }
  return null;
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
  const duration = pickNumber(lap, 'total_elapsed_time');
  const distanceMeters = pickNumber(lap, 'total_distance');
  const distanceKm = distanceMeters === null ? null : distanceMeters / 1000;
  const maxSpeedKmh = pickNumber(lap, 'max_speed');
  const avgPace =
    duration !== null && distanceKm !== null && distanceKm > 0
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
    ascentMeters: pickNumber(lap, 'total_ascent'),
    descentMeters: pickNumber(lap, 'total_descent'),
    avgCadenceSpm: pickNumberAny(lap, ['avg_running_cadence', 'avg_cadence']),
    maxCadenceSpm: pickNumberAny(lap, ['max_running_cadence', 'max_cadence']),
    strideMeters: pickNumber(lap, 'avg_stride_length'),
    calories: pickNumber(lap, 'total_calories'),
  };
}

function buildTotals(views) {
  let durationSeconds = 0;
  let hrWeighted = 0;
  let hrWeight = 0;
  const maxHeartRates = [];
  let distanceKmSum = 0;
  let hasDistance = false;
  let ascentSum = 0;
  let hasAscent = false;

  for (const view of views) {
    if (view.duration !== null) {
      durationSeconds += view.duration;
      if (view.avgHeartRate !== null && view.duration > 0) {
        hrWeighted += view.avgHeartRate * view.duration;
        hrWeight += view.duration;
      }
    }
    if (view.maxHeartRate !== null) maxHeartRates.push(view.maxHeartRate);
    if (view.distanceKm !== null) {
      hasDistance = true;
      distanceKmSum += view.distanceKm;
    }
    if (view.ascentMeters !== null) {
      hasAscent = true;
      ascentSum += view.ascentMeters;
    }
  }

  const distanceKm = hasDistance ? round(distanceKmSum, 3) : null;
  const avgPaceSecondsPerKm =
    distanceKm !== null && distanceKm > 0 && durationSeconds > 0
      ? round(durationSeconds / distanceKm, 1)
      : null;

  return {
    durationSeconds: round(durationSeconds, 2),
    durationLabel: formatDuration(durationSeconds),
    distanceKm,
    distanceLabel: formatDistance(distanceKm),
    avgPaceSecondsPerKm,
    avgPaceLabel: formatPace(avgPaceSecondsPerKm),
    avgHeartRate: hrWeight > 0 ? Math.round(hrWeighted / hrWeight) : null,
    maxHeartRate: maxHeartRates.length ? Math.max(...maxHeartRates) : null,
    ascentMeters: hasAscent ? round(ascentSum, 1) : null,
  };
}

function summarize(data) {
  const source = data ?? {};
  const session = source.sessions?.[0] ?? {};
  const sessionLaps = Array.isArray(session.laps) ? session.laps : [];
  const topLevelLaps = Array.isArray(source.laps) ? source.laps : [];
  const laps = sessionLaps.length ? sessionLaps : topLevelLaps;
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
    totals: buildTotals(lapViews),
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
};
