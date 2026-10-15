'use strict';

const weekly = require('../public/shared/workout-prompts.js');
const analysis = require('../public/shared/analysis-prompts.js');
const { buildMacrocyclePrompt } = require('./prompts');
const { AiError, activeOwner } = require('./memory');
const { TRAINING_COLUMNS } = require('./context');
const PROMPT_VERSION = 'external-prompts-v1';
function renderPrompt(
  db,
  userId,
  { purpose, resourceId = null, targetDate = null },
) {
  const user = activeOwner(db, userId);
  const lang = user.preferred_lang;
  const messages = require(
    `../public/locales/${lang === 'pt-BR' ? 'pt' : 'en'}.json`,
  );
  if (purpose === 'cycle') {
    const cycle = db
      .prepare('SELECT * FROM training_cycles WHERE user_id = ? AND id = ?')
      .get(userId, resourceId);
    if (!cycle) throw new AiError('resourceNotFound', 404);
    return buildMacrocyclePrompt(cycle, lang);
  }
  if (purpose === 'analysis') {
    const training = db
      .prepare(
        `SELECT ${TRAINING_COLUMNS} FROM trainings WHERE user_id = ? AND id = ?`,
      )
      .get(userId, resourceId);
    if (!training) throw new AiError('resourceNotFound', 404);
    const fitData = {
      ...training,
      laps: training.fit_summary_json
        ? JSON.parse(training.fit_summary_json).laps
        : [],
    };
    const form = analysis.buildCanonicalPromptForm(training, {
      language: lang,
      messages,
    });
    return analysis.buildAnalysisPrompt(
      analysis.templateFor(lang),
      analysis.collectPromptValues({
        training,
        form,
        fitData,
        preferences: user,
        messages,
      }),
    );
  }
  if (purpose !== 'workouts') throw new AiError('invalidPurpose');
  const day = weekly.parseInputDate(targetDate);
  if (!day || weekly.dateInputValue(day) !== targetDate || day.getDay() !== 1)
    throw new AiError('invalidDate');
  const cycle = db
    .prepare(
      "SELECT * FROM training_cycles WHERE user_id = ? AND status='active'",
    )
    .get(userId);
  if (!cycle) throw new AiError('resourceNotFound', 404);
  const availability = db
    .prepare(
      'SELECT day_key AS day, can_train, available_periods, available_minutes, location FROM ai_coach_availability WHERE user_id = ? ORDER BY day_key',
    )
    .all(userId)
    .map((row) => ({
      ...row,
      can_train: row.can_train === 1,
      available_periods: JSON.parse(row.available_periods),
    }));
  if (
    availability.length !== 7 ||
    availability.some((row) => weekly.validateAvailabilityDay(row).length)
  )
    throw new AiError('availabilityNeedsReview');
  const trainings = db
    .prepare(`SELECT ${TRAINING_COLUMNS} FROM trainings WHERE user_id = ?`)
    .all(userId);
  const shoes = db
    .prepare(
      'SELECT brand,model,status,mileage,target_mileage FROM shoes WHERE user_id = ? ORDER BY created_at DESC',
    )
    .all(userId);
  return weekly.buildPrompt({
    targetDate: day,
    disponibilidade: availability,
    lang,
    messages,
    shoes,
    ...weekly.buildPromptContext({
      cycle,
      trainings,
      targetDate: day,
      preferences: user,
    }),
  });
}
module.exports = { renderPrompt, PROMPT_VERSION };
