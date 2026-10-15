'use strict';

const { AiError, hash, readMemory, activeOwner, date } = require('./memory');
const { readAiConfig } = require('./config');
const POLICY_VERSION = 'training-context-v2';
const TRAINING_COLUMNS = `id, dia, tipo, treino, detalhes, fc_alvo, rpe, completed, training_cycle_id,
  fit_distance, fit_duration, fit_avg_pace, fit_avg_hr, fit_max_hr, fit_elevation_gain, fit_calories,
  result_data_source, tenis, periodo, location, previsao, observacoes, feedback_shoe, feedback_shoe_id, has_smartwatch, fit_summary_json, feedback_rpe, feedback_notas, feedback_weather, feedback_terrain,
  feedback_breathing, feedback_muscle, feedback_energy, feedback_has_pain, feedback_pain, feedback_hr_source`;
function dayOffset(day, days) {
  return new Date(Date.parse(day) + days * 86400000).toISOString().slice(0, 10);
}
// A conservative byte upper bound, not a claim to be the model's tokenizer.
function tokenBound(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
function duration(value) {
  if (typeof value !== 'string' || !/^\d+(?::[0-5]\d){1,2}$/.test(value))
    return null;
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}
function source(type, row) {
  return { type, id: String(row.id), version: hash(row) };
}
function trainingView(row) {
  const metricKeys = [
    'fit_distance',
    'fit_duration',
    'fit_avg_pace',
    'fit_avg_hr',
    'fit_max_hr',
    'fit_elevation_gain',
    'fit_calories',
    'result_data_source',
  ];
  const plannedKeys = [
    'tipo',
    'treino',
    'detalhes',
    'fc_alvo',
    'rpe',
    'training_cycle_id',
    'tenis',
    'periodo',
    'location',
    'previsao',
    'observacoes',
  ];
  const reports = Object.fromEntries(
    Object.entries(row).filter(([key]) => key.startsWith('feedback_')),
  );
  return {
    date: row.dia,
    source: source('training', row),
    planned: {
      authority: 'planned',
      ...Object.fromEntries(plannedKeys.map((key) => [key, row[key]])),
    },
    actual: {
      authority: 'recorded_fact',
      completed: row.completed === 1,
      ...Object.fromEntries(metricKeys.map((key) => [key, row[key]])),
    },
    report: { authority: 'user_report', observedOn: row.dia, ...reports },
    gaps: [
      'fit_distance',
      'fit_duration',
      'feedback_rpe',
      'feedback_has_pain',
    ].filter((key) => row[key] === null),
  };
}
function buildContext(
  db,
  userId,
  {
    purpose,
    resourceId = null,
    asOf = new Date().toISOString().slice(0, 10),
    config = readAiConfig(),
  },
) {
  if (!['cycle', 'workouts', 'analysis'].includes(purpose))
    throw new AiError('invalidPurpose');
  date(asOf);
  const user = activeOwner(db, userId);
  const memory = readMemory(db, userId);
  const cycle = db
    .prepare(
      "SELECT * FROM training_cycles WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1",
    )
    .get(userId);
  let resource = null;
  if (resourceId !== null) {
    resource =
      purpose === 'analysis'
        ? db
            .prepare(
              `SELECT ${TRAINING_COLUMNS} FROM trainings WHERE id = ? AND user_id = ?`,
            )
            .get(resourceId, userId)
        : db
            .prepare(
              'SELECT * FROM training_cycles WHERE id = ? AND user_id = ?',
            )
            .get(resourceId, userId);
    if (!resource) throw new AiError('resourceNotFound', 404);
  }
  const detailedFrom = dayOffset(asOf, 1 - config.limits.AI_DETAIL_DAYS);
  const aggregateFrom = dayOffset(asOf, 1 - config.limits.AI_HISTORY_WEEKS * 7);
  const rows = db
    .prepare(
      `SELECT ${TRAINING_COLUMNS} FROM trainings WHERE user_id = ? AND dia >= ? AND dia <= ? ORDER BY dia DESC,id DESC`,
    )
    .all(userId, aggregateFrom, asOf);
  const recent = rows.filter((row) => row.dia >= detailedFrom);
  const aggregateRows = rows.filter(
    (row) => row.dia >= aggregateFrom && row.dia < detailedFrom,
  );
  const groups = new Map();
  for (const row of aggregateRows) {
    const d = new Date(row.dia + 'T00:00:00Z');
    const monday = dayOffset(row.dia, -((d.getUTCDay() + 6) % 7));
    if (!groups.has(monday))
      groups.set(monday, {
        weekStart: monday,
        authority: 'derived_fact',
        planned: 0,
        completed: 0,
        distanceKm: 0,
        durationSeconds: 0,
        rpeSum: 0,
        rpeCount: 0,
        missingResults: 0,
        sources: [],
      });
    const g = groups.get(monday);
    g.planned++;
    g.sources.push(source('training', row));
    if (row.completed === 1) {
      g.completed++;
      if (Number.isFinite(row.fit_distance)) g.distanceKm += row.fit_distance;
      const seconds = duration(row.fit_duration);
      if (seconds !== null) g.durationSeconds += seconds;
      if (row.fit_distance === null || seconds === null) g.missingResults++;
      if (Number.isInteger(row.feedback_rpe)) {
        g.rpeSum += row.feedback_rpe;
        g.rpeCount++;
      }
    }
  }
  const references = [];
  const addReference = (ref) => {
    if (
      !references.some((item) => item.type === ref.type && item.id === ref.id)
    )
      references.push(ref);
  };
  const context = {
    policyVersion: POLICY_VERSION,
    purpose,
    asOf,
    units: { distance: 'km', temperature: 'C', duration: 'seconds' },
    preferences: {
      language: user.preferred_lang,
      distance: user.distance_unit,
      temperature: user.temperature_unit,
    },
    ranges: {
      detailedFrom,
      aggregateFrom,
      aggregateTo: dayOffset(detailedFrom, -1),
      plannedTo: dayOffset(asOf, config.limits.AI_DETAIL_DAYS),
    },
    profile: { fields: memory.profile.fields },
    cycle: null,
    resource: null,
    upcoming: [],
    recent: [],
    weekly: [],
    comparables: [],
    availability: [],
    shoes: [],
    sources: references,
    omissions: [],
    gaps: [
      'Unrecorded sessions do not establish rest. Missing symptom reports do not establish resolution. Recommendations are not performed actions.',
    ],
    totalsPolicy:
      'Detailed and aggregated periods are disjoint. Comparable sessions are references, never additional totals.',
  };
  addReference({ type: 'profile', id: 'self', version: hash(context.profile) });
  addReference({
    type: 'preferences',
    id: 'self',
    version: hash(context.preferences),
  });
  // Mandatory context is never silently truncated; a too-small budget refuses dispatch.
  if (cycle) {
    context.cycle = {
      ...cycle,
      user_id: undefined,
      authority: 'applied_record',
    };
    addReference(source('cycle', cycle));
  }
  if (resource) {
    context.resource =
      purpose === 'analysis'
        ? trainingView(resource)
        : { ...resource, user_id: undefined, authority: 'applied_record' };
    addReference(
      source(purpose === 'analysis' ? 'training' : 'cycle', resource),
    );
  }
  if (!cycle)
    context.gaps.push('No active cycle or applied AI planning version.');
  if (!db.prepare('SELECT 1 FROM trainings WHERE user_id = ? AND dia <= ? LIMIT 1').get(userId, asOf))
    context.gaps.push('No recorded training history.');
  if (!Object.keys(memory.profile.fields).length)
    context.gaps.push('Optional prior running experience has not been supplied.');
  const budget = config.limits.AI_CONTEXT_TOKENS;
  if (tokenBound(context) > budget)
    throw new AiError('criticalContextTooLarge', 413);
  function select(key, item, refs) {
    context[key].push(item);
    const before = references.length;
    refs.forEach(addReference);
    if (tokenBound(context) > budget - 1024) {
      context[key].pop();
      references.splice(before);
      context.omissions.push({
        type: key,
        id: refs[0].id,
        reason: 'context_budget',
      });
    }
  }
  const availability = db
    .prepare(
      'SELECT day_key,can_train,available_periods,available_minutes,location,updated_at FROM ai_coach_availability WHERE user_id = ? ORDER BY day_key',
    )
    .all(userId);
  for (const row of availability)
    select('availability', row, [
      { type: 'availability', id: row.day_key, version: hash(row) },
    ]);
  if (availability.length !== 7)
    context.gaps.push('Weekly availability is incomplete.');
  const upcoming = db
    .prepare(
      `SELECT ${TRAINING_COLUMNS} FROM trainings WHERE user_id = ? AND dia > ? AND dia <= ? ORDER BY dia,id`,
    )
    .all(userId, asOf, context.ranges.plannedTo);
  for (const row of upcoming)
    select('upcoming', trainingView(row), [source('training', row)]);
  for (const row of recent)
    select('recent', trainingView(row), [source('training', row)]);
  for (const g of groups.values())
    select(
      'weekly',
      { ...g, averageRpe: g.rpeCount ? g.rpeSum / g.rpeCount : null },
      g.sources,
    );
  // Retrieve at most three comparable records, including older history; never load the entire log.
  const ranked = db.prepare(`SELECT ${TRAINING_COLUMNS} FROM trainings
    WHERE user_id = ? AND dia < ? AND completed = 1
      AND (? != 'analysis' OR tipo = ?)
      AND (? != 'workouts' OR lower(tipo) LIKE '%long%' OR lower(treino) LIKE '%long%')
    ORDER BY dia DESC,id DESC LIMIT 3`).all(userId, detailedFrom, purpose, resource?.tipo ?? null, purpose);
  for (const row of ranked)
    select(
      'comparables',
      {
        ...trainingView(row),
        includedInAggregates: row.dia >= aggregateFrom,
        selectionReason:
          purpose === 'analysis'
            ? 'same_training_type'
            : purpose === 'workouts'
              ? 'previous_long_run'
              : 'previous_completed_session',
      },
      [source('training', row)],
    );
  for (const row of db
    .prepare(
      'SELECT id,brand,model,status,mileage,target_mileage,updated_at FROM shoes WHERE user_id = ? ORDER BY id',
    )
    .all(userId))
    select('shoes', row, [source('shoe', row)]);
  const olderCount = db.prepare('SELECT COUNT(*) AS n FROM trainings WHERE user_id = ? AND dia < ?').get(userId, aggregateFrom).n;
  if (olderCount)
    context.omissions.push({
      type: 'training',
      count: olderCount,
      reason: 'historical_cutoff_except_comparables',
    });
  // Bound omission reporting too, without concealing the number of excluded items.
  if (context.omissions.length > 5)
    context.omissions = [
      { reason: 'selection_omissions', count: context.omissions.length },
      ...context.omissions.slice(0, 3),
    ];
  const snapshot = { ...context, hash: hash(context) };
  if (tokenBound(snapshot) > budget) throw new AiError('contextTooLarge', 413);
  return snapshot;
}
function contextIsCurrent(db, userId, context, config) {
  try {
    if (context.policyVersion !== POLICY_VERSION) return false;
    return (
      buildContext(db, userId, {
        purpose: context.purpose,
        resourceId:
          context.resource?.source?.id || context.resource?.id || null,
        asOf: context.asOf,
        config,
      }).hash === context.hash
    );
  } catch (error) {
    if (error instanceof AiError) return false;
    throw error;
  }
}
module.exports = {
  POLICY_VERSION,
  TRAINING_COLUMNS,
  buildContext,
  contextIsCurrent,
  tokenBound,
  duration,
};
