'use strict';

const { AiError, hash, readMemory, activeOwner, date } = require('./memory');
const { readAiConfig } = require('./config');
const { rpeIssue } = require('./cycle-plan-schema');
const POLICY_VERSION = 'training-context-v5';
const ANALYSIS_POLICY_VERSION = 'training-analysis-context-v1';
const TRAINING_COLUMNS = `id, dia, tipo, treino, detalhes, fc_alvo, rpe, completed, training_cycle_id,
  fit_distance, fit_duration, fit_avg_pace, fit_avg_hr, fit_max_hr, fit_elevation_gain, fit_calories,
  result_data_source, tenis, periodo, location, previsao, observacoes, feedback_shoe, feedback_shoe_id, has_smartwatch, fit_summary_json, feedback_rpe, feedback_notas, feedback_weather, feedback_terrain,
  feedback_breathing, feedback_muscle, feedback_energy, feedback_has_pain, feedback_pain, feedback_hr_source`;
function dayOffset(day, days) {
  return new Date(Date.parse(day) + days * 86400000).toISOString().slice(0, 10);
}
function projectContextForModel(context) {
  if (context?.purpose === 'analysis') {
    const result = { ...context };
    delete result._freshnessExecutionId;
    return result;
  }
  if (!context || context.purpose !== 'workouts') return context;
  const result = { ...context };
  delete result.hash;
  const limitations = new Set();
  if (Array.isArray(context.weather))
    result.weather = context.weather.map((evidence) => {
      for (const item of evidence?.limitations || [])
        if (typeof item === 'string') limitations.add(item);
      const fields = [
        'weekday', 'date', 'period', 'source', 'sourceUrl', 'lookedUpAt',
        'timezone', 'status', 'reason', 'coverage', 'window', 'hours',
      ];
      return Object.fromEntries(
        fields.filter((key) => Object.hasOwn(evidence || {}, key))
          .map((key) => [key, evidence[key]]),
      );
    });
  if (limitations.size) result.weatherLimitations = [...limitations];
  const stripSourceVersions = (value) => {
    if (Array.isArray(value)) return value.map(stripSourceVersions);
    if (!value || typeof value !== 'object') return value;
    if (typeof value.type === 'string' && Object.hasOwn(value, 'id') &&
        Object.hasOwn(value, 'version'))
      return { type: value.type, id: value.id };
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stripSourceVersions(item)]),
    );
  };
  return stripSourceVersions(result);
}

// A conservative byte upper bound, not a claim to be the model's tokenizer.
// Workouts retain the complete evidence in the execution snapshot, while the
// budget uses the smaller model projection that omits owner/query bindings.
function tokenBound(value) {
  const bounded = projectContextForModel(value);
  return Buffer.byteLength(JSON.stringify(bounded), 'utf8');
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
// A selection rank, not a diagnosis or a persistent athlete restriction.
function recentPriority(row) {
  if (
    row.feedback_has_pain === 'yes' ||
    (typeof row.feedback_pain === 'string' && row.feedback_pain.trim() !== '')
  )
    return 6;
  return Number.isInteger(row.feedback_rpe) &&
    row.feedback_rpe >= 1 &&
    row.feedback_rpe <= 5
    ? row.feedback_rpe
    : 0;
}
const PLANNING_DETAIL_FIELDS = ['detalhes', 'observacoes', 'previsao'];
function compactSession(row) {
  const view = trainingView(row);
  for (const key of PLANNING_DETAIL_FIELDS) delete view.planned[key];
  return view;
}
function buildContext(
  db,
  userId,
  {
    purpose,
    resourceId = null,
    asOf = new Date().toISOString().slice(0, 10),
    config = readAiConfig(),
    taskDate = null,
    weather = [],
    taskNotes = '',
    freshnessExecutionId = null,
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
  const resourceTrainingId =
    purpose === 'analysis' ? (resource?.id ?? null) : null;
  const recent = rows
    .filter((row) => row.dia >= detailedFrom && row.id !== resourceTrainingId)
    .sort(
      (a, b) =>
        recentPriority(b) - recentPriority(a) ||
        b.dia.localeCompare(a.dia) ||
        b.id - a.id,
    );
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
    policyVersion: purpose === 'analysis' ? ANALYSIS_POLICY_VERSION : POLICY_VERSION,
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
      'Detailed and aggregated periods are disjoint. Requested and comparable sessions are references, never additional totals; includedInAggregates identifies overlap. Each detailed session appears once.',
  };
  if (purpose === 'analysis' && freshnessExecutionId)
    context._freshnessExecutionId = freshnessExecutionId;
  if (purpose === 'workouts') {
    context.resource = { weekStart: date(taskDate || asOf) };
    context.weather = Array.isArray(weather) ? weather : [];
    for (const evidence of context.weather) {
      if (
        evidence &&
        typeof evidence.weekday === 'string' &&
        typeof evidence.date === 'string'
      )
        addReference({
          type: 'weather',
          id: `${evidence.weekday}:${evidence.date}`,
          version: hash(evidence),
        });
    }
    if (typeof taskNotes === 'string' && taskNotes.trim())
      context.taskNotes = { authority: 'user_report', text: taskNotes.trim() };
  }
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
    if (purpose === 'analysis')
      context.resource.includedInAggregates =
        resource.dia >= aggregateFrom && resource.dia < detailedFrom;
    if (purpose === 'analysis' && resource.result_data_source === 'fit_upload') {
      try {
        const laps = JSON.parse(resource.fit_summary_json || '{}').laps;
        if (Array.isArray(laps)) context.resource.actual.fitLaps = laps.slice(0, 200).map((lap) => ({
          lap: lap.lap, stepType: lap.stepType, duration: lap.duration,
          distanceKm: lap.distanceKm, avgPaceSecondsPerKm: lap.avgPaceSecondsPerKm,
          avgHeartRate: lap.avgHeartRate, maxHeartRate: lap.maxHeartRate,
          ascentMeters: lap.ascentMeters, avgCadenceSpm: lap.avgCadenceSpm,
          maxCadenceSpm: lap.maxCadenceSpm,
        }));
      } catch {
        context.resource.actual.fitLaps = [];
      }
    }
    addReference(
      source(purpose === 'analysis' ? 'training' : 'cycle', resource),
    );
  }
  if (purpose === 'analysis' && resource?.training_cycle_id) {
    const associated = db.prepare('SELECT * FROM training_cycles WHERE id=? AND user_id=?').get(resource.training_cycle_id, userId);
    if (associated) {
      context.associatedCycle = { ...associated, user_id: undefined, authority: 'associated_record' };
      addReference(source('cycle', associated));
    }
  }
  if (!cycle)
    context.gaps.push('No active cycle or applied AI planning version.');
  if (
    !db
      .prepare('SELECT 1 FROM trainings WHERE user_id = ? AND dia <= ? LIMIT 1')
      .get(userId, asOf)
  )
    context.gaps.push('No recorded training history.');
  if (!Object.keys(memory.profile.fields).length)
    context.gaps.push(
      'Optional prior running experience has not been supplied.',
    );
  let appliedDetails = null;
  const planningCycle = purpose === 'analysis' ? (context.associatedCycle || cycle) : cycle;
  if (purpose !== 'cycle' && planningCycle) {
    const applied = db
      .prepare(
        'SELECT * FROM cycle_plan_versions WHERE user_id=? AND cycle_id=? ORDER BY version DESC LIMIT 1',
      )
      .get(userId, planningCycle.id);
    if (applied) {
      const plan = JSON.parse(applied.plan_json);
      context.appliedPlan = {
        authority: 'applied_planning',
        cycleId: planningCycle.id,
        version: applied.version,
        executionId: applied.id,
        appliedAt: applied.applied_at,
        outdated: !contextIsCurrent(
          db,
          userId,
          JSON.parse(applied.fingerprint_json),
          config,
        ),
        start: plan.start,
        end: plan.end,
        architecture: [],
        phases: [],
        indicators: [],
        adaptations: null,
        uncertainties: [],
      };
      if (rpeIssue(plan)) {
        context.appliedPlan.compatibilityError = 'planningRpeIncompatible';
        context.omissions.push({
          type: 'cycle_plan',
          id: applied.id,
          reason: 'incompatible_rpe_scale',
        });
        context.gaps.push(
          'Applied planning guidance is excluded because it contains an incompatible RPE scale. The original remains available for review and explicit replacement.',
        );
      } else {
        appliedDetails = {
          architecture: plan.phases.map(({ name, start, end, objective }) => ({
            name,
            start,
            end,
            objective,
          })),
          phases: plan.phases.filter(
            (phase) =>
              phase.end >= asOf && phase.start <= context.ranges.plannedTo,
          ),
          indicators: plan.indicators,
          adaptations: plan.adaptations,
          uncertainties: plan.uncertainties,
        };
        const outsideWindow = plan.phases.length - appliedDetails.phases.length;
        if (outsideWindow)
          context.omissions.push({
            type: 'cycle_plan_phases',
            count: outsideWindow,
            reason: 'phase_details_outside_task_window',
          });
      }
      addReference({
        type: 'cycle_plan',
        id: applied.id,
        version: hash(applied),
      });
    }
  }
  const budget = config.limits.AI_CONTEXT_TOKENS;
  const reduced = (key, row) => ({
    type: key,
    id: String(row.id),
    reason: 'planning_details_omitted',
    fields: PLANNING_DETAIL_FIELDS,
  });
  // All recent explicit concerns and RPE 4/5 reports are retained whole before
  // optional details. If these cores cannot fit, refuse rather than hide them.
  const critical = recent.filter((row) => recentPriority(row) >= 4);
  for (const row of critical) {
    context.recent.push(compactSession(row));
    addReference(source('training', row));
    context.omissions.push(reduced('recent', row));
  }
  function trySelect(key, item, refs, omission = null, target = context) {
    const previous = target[key];
    target[key] = Array.isArray(previous) ? [...previous, item] : item;
    const before = references.length;
    refs.forEach(addReference);
    if (omission) context.omissions.push(omission);
    if (tokenBound(context) > budget - 1024) {
      target[key] = previous;
      references.splice(before);
      if (omission) context.omissions.pop();
      return false;
    }
    return true;
  }
  function select(key, item, refs, target = context) {
    if (!trySelect(key, item, refs, null, target))
      context.omissions.push({
        type: key,
        id: refs[0].id,
        reason: 'context_budget',
      });
  }
  const availability = db
    .prepare(
      'SELECT day_key,can_train,available_periods,available_minutes,location,revision,updated_at FROM ai_coach_availability WHERE user_id = ? ORDER BY day_key',
    )
    .all(userId);
  if (availability.length !== 7)
    context.gaps.push('Weekly availability is incomplete.');
  const availabilitySource = (row) => ({
    type: 'availability',
    id: row.day_key,
    version: hash(row),
  });
  // Configured availability is essential for workouts. Missing days stay missing.
  if (purpose === 'workouts')
    for (const row of availability) {
      context.availability.push(row);
      addReference(availabilitySource(row));
    }
  if (tokenBound(context) > budget)
    throw new AiError('criticalContextTooLarge', 413);
  for (const row of recent.filter((row) => recentPriority(row) < 4)) {
    if (
      !trySelect(
        'recent',
        compactSession(row),
        [source('training', row)],
        reduced('recent', row),
      )
    )
      context.omissions.push({
        type: 'recent',
        id: String(row.id),
        reason: 'context_budget',
      });
  }
  if (purpose !== 'workouts')
    for (const row of availability)
      select('availability', row, [availabilitySource(row)]);
  if (purpose === 'cycle') {
    context.previousCycles = [];
    for (const previous of db
      .prepare(
        "SELECT * FROM training_cycles WHERE user_id=? AND id!=? AND status!='active' ORDER BY created_at DESC,id LIMIT 3",
      )
      .all(userId, resourceId ?? ''))
      select(
        'previousCycles',
        { ...previous, user_id: undefined, authority: 'applied_record' },
        [source('cycle', previous)],
      );
  }
  // Applied plan identity/provenance is mandatory, but its prose must never
  // displace reports or task availability. Architecture precedes phase detail;
  // each whole optional item uses the same budget and omission path as sessions.
  if (appliedDetails) {
    const refs = references.filter((ref) => ref.type === 'cycle_plan');
    for (const key of [
      'architecture',
      'phases',
      'indicators',
      'adaptations',
      'uncertainties',
    ]) {
      const items = Array.isArray(appliedDetails[key])
        ? appliedDetails[key]
        : [appliedDetails[key]];
      for (const item of items) select(key, item, refs, context.appliedPlan);
    }
  }
  // Only after compact reports have had their turn, spend spare bytes on planning prose.
  for (const row of recent) {
    const index = context.recent.findIndex(
      (view) => view.source.id === String(row.id),
    );
    if (index === -1) continue;
    const compact = context.recent[index];
    const omissionIndex = context.omissions.findIndex(
      (item) => item.type === 'recent' && item.id === String(row.id),
    );
    const [omission] = context.omissions.splice(omissionIndex, 1);
    context.recent[index] = trainingView(row);
    if (tokenBound(context) > budget - 1024) {
      context.recent[index] = compact;
      context.omissions.splice(omissionIndex, 0, omission);
    }
  }
  for (const g of groups.values())
    select(
      'weekly',
      { ...g, averageRpe: g.rpeCount ? g.rpeSum / g.rpeCount : null },
      g.sources,
    );
  // Retrieve at most three comparable records, including older history; never load the entire log.
  const ranked = db
    .prepare(
      `SELECT ${TRAINING_COLUMNS} FROM trainings
    WHERE user_id = ? AND dia < ? AND completed = 1
      AND (? IS NULL OR id != ?)
      AND (? != 'analysis' OR tipo = ?)
      AND (? != 'workouts' OR lower(tipo) LIKE '%long%' OR lower(treino) LIKE '%long%')
    ORDER BY dia DESC,id DESC LIMIT 3`,
    )
    .all(
      userId,
      detailedFrom,
      resourceTrainingId,
      resourceTrainingId,
      purpose,
      resource?.tipo ?? null,
      purpose,
    );
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
  const upcoming = db
    .prepare(
      `SELECT ${TRAINING_COLUMNS} FROM trainings
    WHERE user_id = ? AND dia > ? AND dia <= ? AND (? IS NULL OR id != ?)
    ORDER BY dia,id`,
    )
    .all(
      userId,
      asOf,
      context.ranges.plannedTo,
      resourceTrainingId,
      resourceTrainingId,
    );
  for (const row of upcoming) {
    const refs = [source('training', row)];
    if (
      !trySelect('upcoming', trainingView(row), refs) &&
      !trySelect(
        'upcoming',
        compactSession(row),
        refs,
        reduced('upcoming', row),
      )
    )
      context.omissions.push({
        type: 'upcoming',
        id: String(row.id),
        reason: 'context_budget',
      });
  }
  for (const row of db
    .prepare(
      'SELECT id,brand,model,status,mileage,target_mileage,updated_at FROM shoes WHERE user_id = ? ORDER BY id',
    )
    .all(userId))
    select('shoes', row, [source('shoe', row)]);
  // Only current, owner-scoped dispositions enter a context. An interpretation
  // whose evidence source is no longer selected at its captured version stays
  // in its history but is not made current again by opening an older analysis.
  const interpretationRows = db.prepare(`SELECT * FROM ai_interpretations
    WHERE user_id=? AND disposition IN ('pending','confirmed','corrected')
      AND (? IS NULL OR analysis_id<>?)
    ORDER BY updated_at DESC,id`).all(userId, freshnessExecutionId, freshnessExecutionId);
  // A newly completed analysis may explicitly supersede an interpretation it
  // consumed as input. Rehydrate that exact pre-replacement snapshot only when
  // checking this analysis's freshness; other/future contexts see the new
  // disposition and never resurrect the old item.
  if (freshnessExecutionId) {
    const known = new Set(interpretationRows.map((item) => item.id));
    const replaced = db.prepare(`SELECT replaced_snapshot_json FROM ai_interpretation_replacements
      WHERE user_id=? AND replacement_analysis_id=? ORDER BY id`).all(userId, freshnessExecutionId);
    for (const item of replaced.map((row) => JSON.parse(row.replaced_snapshot_json)))
      if (!known.has(item.id)) { interpretationRows.push(item); known.add(item.id); }
  }
  interpretationRows.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  interpretationRows.length = Math.min(24, interpretationRows.length);
  const interpretationById = new Map(interpretationRows.map((item) => [item.id, item]));
  const pendingInterpretations = [...interpretationRows];
  const selectedInterpretationVersions = new Map();
  const budgetOmitted = new Set();
  // Resolve at most one item per candidate per pass. A child can wait for any
  // exact, owner-scoped candidate dependency regardless of updated_at order;
  // the fixed candidate cap and pass bound also make cycles terminate safely.
  for (let pass = 0; pass < interpretationRows.length && pendingInterpretations.length; pass += 1) {
    let selectedInPass = false;
    for (let index = 0; index < pendingInterpretations.length;) {
      const item = pendingInterpretations[index];
      const evidence = JSON.parse(item.evidence_json);
      const ready = evidence.every((ref) => {
        if (ref.type === 'interpretation')
          return selectedInterpretationVersions.get(ref.id) === ref.version;
        return references.some((current) => current.type === ref.type && current.id === ref.id && current.version === ref.version);
      });
      if (!ready) {
        const waiting = evidence.some((ref) => {
          if (ref.type !== 'interpretation' || selectedInterpretationVersions.has(ref.id)) return false;
          const dependency = interpretationById.get(ref.id);
          return Boolean(dependency && hash(dependency) === ref.version && pendingInterpretations.includes(dependency));
        });
        if (waiting) { index += 1; continue; }
        pendingInterpretations.splice(index, 1);
        continue;
      }
      const text = item.disposition === 'corrected' ? item.correction_text : item.text;
      if (!text) { pendingInterpretations.splice(index, 1); continue; }
      const view = {
        source: { type: 'interpretation', id: item.id, version: hash(item) },
        kind: item.kind,
        authority: item.disposition === 'corrected' ? 'user_report' : 'ai_interpretation',
        disposition: item.disposition,
        statusMeaning: item.disposition === 'pending' ? 'unconfirmed_hypothesis' : item.disposition,
        text,
        evidence,
        observedOn: item.updated_at.slice(0, 10),
      };
      if (!Object.hasOwn(context, 'interpretations')) context.interpretations = [];
      if (!trySelect('interpretations', view, [view.source])) {
        context.omissions.push({ type: 'interpretation', reason: 'context_budget' });
        budgetOmitted.add(item.id);
      } else {
        selectedInPass = true;
        selectedInterpretationVersions.set(item.id, view.source.version);
      }
      pendingInterpretations.splice(index, 1);
    }
    if (!selectedInPass) break;
  }
  // Items blocked only because a valid dependency did not fit the budget get
  // the same explicit omission as that dependency. Cycles and stale/absent
  // sources remain quietly excluded, as before.
  const reportedBudgetOmissions = new Set(budgetOmitted);
  for (let pass = 0; pass <= pendingInterpretations.length; pass += 1) {
    let propagated = false;
    for (const item of pendingInterpretations) {
      if (reportedBudgetOmissions.has(item.id)) continue;
      const evidence = JSON.parse(item.evidence_json);
      if (evidence.some((ref) => ref.type === 'interpretation' && budgetOmitted.has(ref.id))) {
        context.omissions.push({ type: 'interpretation', reason: 'context_budget' });
        budgetOmitted.add(item.id);
        reportedBudgetOmissions.add(item.id);
        propagated = true;
      }
    }
    if (!propagated) break;
  }

  const olderCount = db
    .prepare(
      'SELECT COUNT(*) AS n FROM trainings WHERE user_id = ? AND dia < ?',
    )
    .get(userId, aggregateFrom).n;
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
    const expectedPolicy = context.purpose === 'analysis' ? ANALYSIS_POLICY_VERSION : POLICY_VERSION;
    if (context.policyVersion !== expectedPolicy) return false;
    return (
      buildContext(db, userId, {
        purpose: context.purpose,
        resourceId:
          context.resource?.source?.id || context.resource?.id || null,
        asOf: context.asOf,
        config,
        taskDate: context.resource?.weekStart,
        weather: context.weather || [],
        taskNotes: context.taskNotes?.text || '',
        freshnessExecutionId: context._freshnessExecutionId || null,
      }).hash === context.hash
    );
  } catch (error) {
    if (error instanceof AiError) return false;
    throw error;
  }
}
module.exports = {
  POLICY_VERSION,
  ANALYSIS_POLICY_VERSION,
  TRAINING_COLUMNS,
  buildContext,
  contextIsCurrent,
  tokenBound,
  projectContextForModel,
  duration,
};
