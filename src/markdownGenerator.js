'use strict';

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatMetric(value) {
  return value === null || value === undefined ? '-' : String(value);
}

const PROMPT_HEADER = [
  '# AI Coach Review Request',
  '',
  'You are a professional endurance coach reviewing a completed structured workout.',
  'Analyse the lap metrics table below together with the athlete feedback.',
  'Answer with: overall assessment, lap-by-lap insights, and concrete adjustments for upcoming sessions.',
].join('\n');

const PROMPT_FOOTER =
  'Ground every recommendation in the table metrics: paces in min/km, heart rate in bpm, cadence in steps per minute, elevation in meters, energy in kcal.';

const TABLE_HEADER =
  '| Step | Lap | Time | Cumulative | Distance (km) | Avg Pace | Best Pace | Avg HR | Max HR | Ascent | Descent | Avg Cadence | Max Cadence | Stride (m) | Calories |';

const TABLE_DIVIDER = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

function toRow(lap) {
  const cells = [
    lap.stepType,
    lap.lap,
    lap.durationLabel,
    lap.cumulativeLabel,
    lap.distanceLabel,
    lap.avgPaceLabel,
    lap.bestPaceLabel,
    formatMetric(lap.avgHeartRate),
    formatMetric(lap.maxHeartRate),
    formatMetric(lap.ascentMeters),
    formatMetric(lap.descentMeters),
    formatMetric(lap.avgCadenceSpm),
    formatMetric(lap.maxCadenceSpm),
    formatMetric(lap.strideMeters),
    formatMetric(lap.calories),
  ];
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

function buildLapSection(laps) {
  if (!laps.length) return ['## Laps', '', '_No laps detected in this file._', ''];
  return ['## Laps', '', TABLE_HEADER, TABLE_DIVIDER, ...laps.map(toRow), ''];
}

function generateMarkdown(summary, feedback = {}) {
  const activity = summary.activity;
  const lines = [
    PROMPT_HEADER,
    '',
    '## Session Overview',
    '',
    `- **Activity Type:** ${activity.sport ?? 'unknown'}`,
    `- **Start Time:** ${activity.startTime ?? 'not recorded'}`,
    `- **End Time:** ${activity.endTime ?? 'not recorded'}`,
    '',
    ...buildLapSection(summary.laps),
    '## Athlete Feedback',
    '',
    `- **RPE:** ${feedback.rpe == null ? 'not informed' : `${feedback.rpe}/10`}`,
    `- **Notes:** ${feedback.notes ? escapeCell(feedback.notes) : 'not informed'}`,
    '',
    PROMPT_FOOTER,
    '',
  ];
  return lines.join('\n');
}

module.exports = { generateMarkdown, escapeCell, formatMetric };
