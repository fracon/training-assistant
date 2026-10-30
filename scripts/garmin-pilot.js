'use strict';

const { resolveDatabaseFile } = require('../src/db/database');
const { createPrompts } = require('./admin-prompts');
const Database = require('better-sqlite3');
const { parseFitFile } = require('../src/fitParser');
const { resolveFitBuffer } = require('../src/fitUpload');

const API = process.env.GARMIN_CONNECTOR_URL || 'http://garmin-connector:8080';
const OWNER_ID = process.env.GARMIN_PILOT_USER_ID || '';
const CONNECTION_ID = 'pilot';

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-kinesis-service-key': process.env.KINESIS_GARMIN_SERVICE_TOKEN || '',
      ...options.headers,
    },
    signal: AbortSignal.timeout(180000),
  });
  const body = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : {};
  if (!response.ok) throw new Error(body?.detail?.code || 'unavailable');
  return body;
}

async function requestOriginal(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'x-kinesis-service-key': process.env.KINESIS_GARMIN_SERVICE_TOKEN || '' },
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.detail?.code || 'unavailable');
  }
  const maxBytes = 25 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('invalid_payload');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error('invalid_payload');
  return data;
}

function validatePilot() {
  if (process.env.GARMIN_PILOT_ENABLED !== 'true') {
    throw new Error('Garmin pilot is disabled.');
  }
  if (!/^\d+$/.test(OWNER_ID) || !process.env.KINESIS_GARMIN_SERVICE_TOKEN) {
    throw new Error('Set the local pilot owner and connector service key first.');
  }
  const db = new Database(process.env.DATABASE_FILE || resolveDatabaseFile(process.cwd()), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const owner = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(Number(OWNER_ID));
    if (!owner || owner.is_active !== 1) throw new Error('Configured pilot account is missing or inactive.');
  } finally {
    db.close();
  }
}

async function main() {
  const action = process.argv[2] || 'status';
  if (process.argv.length > 3) throw new Error('Arguments are not accepted; use the local prompts.');
  validatePilot();
  const prefix = `/v1/connections/${OWNER_ID}/${CONNECTION_ID}`;
  const prompts = createPrompts();
  if (['auth', 'disconnect', 'publish-simple', 'publish-interval', 'schedule', 'activities', 'download', 'cancel'].includes(action)) {
    prompts.assertInteractive();
  }
  if (action === 'status') {
    const value = await request(`${prefix}/status`);
    process.stdout.write(`${value.status}\n`);
    return;
  }
  if (action === 'disconnect') {
    const confirmation = await prompts.question('Type disconnect to remove local Garmin tokens: ');
    if (confirmation !== 'disconnect') throw new Error('Disconnect cancelled.');
    const value = await request(prefix, { method: 'DELETE' });
    process.stdout.write(`${value.status}; remote revocation: ${value.remote_revocation}\n`);
    return;
  }
  if (action === 'publish-simple') {
    const operationId = await prompts.question('Operation ID (blank creates one; reuse it to reconcile): ');
    const id = operationId || require('node:crypto').randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Operation ID must be a UUID.');
    process.stdout.write(`Record this operation ID for reconciliation: ${id}\n`);
    if (await prompts.question('Type publish to send a synthetic workout: ') !== 'publish') {
      throw new Error('Publication cancelled.');
    }
    const value = await request(`${prefix}/workouts`, {
      method: 'POST',
      body: JSON.stringify({
        operation_id: id,
        name: 'synthetic easy run', interval_seconds: 900,
      }),
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (action === 'publish-interval') {
    const operationId = await prompts.question('Operation ID (blank creates one; reuse it to reconcile): ');
    const id = operationId || require('node:crypto').randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Operation ID must be a UUID.');
    process.stdout.write(`Record this operation ID for reconciliation: ${id}\n`);
    if (await prompts.question('Type publish to send a synthetic workout: ') !== 'publish') {
      throw new Error('Publication cancelled.');
    }
    const value = await request(`${prefix}/workouts`, {
      method: 'POST',
      body: JSON.stringify({
        operation_id: id,
        name: 'synthetic intervals', warmup_seconds: 300,
        interval_seconds: 120, recovery_seconds: 60, repetitions: 4,
        cooldown_seconds: 240, target_lower_mps: 2.7, target_upper_mps: 3.1,
      }),
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (!['auth', 'schedule', 'activities', 'download', 'cancel'].includes(action)) {
    throw new Error('Use auth, status, disconnect, publish-simple, publish-interval, schedule, activities, download, or cancel.');
  }

  if (action === 'schedule') {
    const workoutId = await prompts.question('Synthetic Garmin workout ID: ');
    const date = await prompts.question('Calendar date (YYYY-MM-DD, Europe/Lisbon): ');
    if (!/^\d+$/.test(workoutId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('Enter a numeric workout ID and a civil calendar date.');
    }
    if (await prompts.question('Type schedule to add this synthetic workout to the calendar: ') !== 'schedule') {
      throw new Error('Scheduling cancelled.');
    }
    const value = await request(`${prefix}/workouts/schedule`, {
      method: 'POST', body: JSON.stringify({ workout_id: Number(workoutId), date }),
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (action === 'activities') {
    const start = await prompts.question('Start date (YYYY-MM-DD): ');
    const end = await prompts.question('End date (YYYY-MM-DD, maximum 31 days): ');
    const value = await request(`${prefix}/activities`, {
      method: 'POST', body: JSON.stringify({ start, end, limit: 10 }),
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (action === 'download') {
    const activityId = await prompts.question('Your Garmin activity ID: ');
    if (!/^\d+$/.test(activityId)) throw new Error('Activity ID must be numeric.');
    const archive = await requestOriginal(`${prefix}/activities/${activityId}/original`);
    const fit = await resolveFitBuffer({ buffer: archive, filename: 'garmin-original.zip' });
    const summary = await parseFitFile(fit);
    process.stdout.write(`${JSON.stringify({
      activity: summary.activity,
      totals: summary.totals,
      laps: summary.laps.length,
      bytes: archive.length,
    })}\n`);
    return;
  }
  if (action === 'cancel') {
    const challengeId = await prompts.question('Pending MFA challenge ID: ');
    const result = await request(`${prefix}/auth/cancel`, {
      method: 'POST', body: JSON.stringify({ challenge_id: challengeId }),
    });
    process.stdout.write(`${result.status}\n`);
    return;
  }
  const email = await prompts.question('Garmin email: ');
  let password = await prompts.secret('Garmin password: ');
  try {
    const result = await request(`${prefix}/auth/start`, {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    if (result.status === 'mfa_required') {
      process.stdout.write(`MFA challenge ID (expires in 5 minutes): ${result.challenge_id}\n`);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = await prompts.secret('Garmin MFA code: ');
        try {
          const completed = await request(`${prefix}/auth/finish`, {
            method: 'POST', body: JSON.stringify({ challenge_id: result.challenge_id, code }),
          });
          process.stdout.write(`${completed.status}\n`);
          return;
        } catch (error) {
          process.stderr.write(`Authentication attempt failed (${error.message}).\n`);
          if (attempt === 2) throw error;
        }
      }
    } else {
      process.stdout.write(`${result.status}\n`);
    }
  } finally {
    password = '';
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
