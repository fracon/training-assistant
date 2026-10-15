'use strict';

const MODELS = ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'];
const LIMITS = {
  AI_MAX_OUTPUT_TOKENS: [2048, 128, 8192],
  AI_TIMEOUT_MS: [60000, 1000, 180000],
  AI_CONCURRENCY_GLOBAL: [2, 1, 8],
  AI_CONCURRENCY_USER: [1, 1, 2],
  AI_DAILY_TOKENS_USER: [100000, 1000, 10000000],
  AI_DAILY_TOKENS_GLOBAL: [500000, 1000, 100000000],
  AI_DAILY_CALLS_USER: [10, 1, 100],
  AI_DAILY_CALLS_GLOBAL: [100, 1, 1000],
  AI_CONTEXT_TOKENS: [12000, 1000, 24000],
  AI_HISTORY_WEEKS: [12, 8, 12],
  AI_DETAIL_DAYS: [14, 7, 28],
  AI_RETENTION_DAYS: [90, 7, 365],
  AI_RETRIES: [1, 0, 2],
};
function readAiConfig(env = process.env) {
  const errors = [];
  const config = {
    enabled: env.AI_ENABLED === 'true',
    models: {},
    apiKey: (env.OPENAI_API_KEY || '').trim(),
    limits: {},
  };
  if (/\r|\n/.test(config.apiKey)) errors.push('OPENAI_API_KEY');
  if (env.AI_ENABLED && !['true', 'false'].includes(env.AI_ENABLED))
    errors.push('AI_ENABLED');
  for (const [key, [fallback, min, max]] of Object.entries(LIMITS)) {
    const value =
      env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max)
      errors.push(key);
    config.limits[key] = value;
  }
  for (const purpose of ['cycle', 'workouts', 'analysis']) {
    const key = `AI_MODEL_${purpose.toUpperCase()}`;
    const model = env[key] || 'gpt-6.1-sol';
    if (!MODELS.includes(model)) errors.push(key);
    config.models[purpose] = model;
  }
  for (const [key, fallback] of Object.entries({
    AI_DAILY_USD_USER: 2,
    AI_DAILY_USD_GLOBAL: 20,
  })) {
    const value =
      env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value <= 0 || value > 1000) errors.push(key);
    config.limits[key] = value;
  }
  if (!config.apiKey) config.enabled = false;
  config.errors = errors;
  if (errors.length) config.enabled = false;
  return config;
}
// Conservative published rate ceilings, USD / million tokens, 2026-10-14.
// No tools, fast/ultrafast tiers or automatic model fallback are enabled.
const RATES = {
  'gpt-6.1-sol': { input: 4, cached: 0.2, cacheWrite: 5, output: 15 },
  'gpt-6-luna': { input: 0.2, cached: 0.02, cacheWrite: 0.25, output: 0.75 },
  'gpt-6-astra': { input: 20, cached: 2, cacheWrite: 25, output: 75 },
};
module.exports = { readAiConfig, LIMITS, MODELS, RATES };
