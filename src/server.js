'use strict';

const path = require('node:path');
const Fastify = require('fastify');
const multipart = require('@fastify/multipart');
const fastifyStatic = require('@fastify/static');
const fastifyCookie = require('@fastify/cookie');
const { parseFitFile } = require('./fitParser');
const { generateMarkdown } = require('./markdownGenerator');
const { registerUser, RegistrationError } = require('./auth/registration');
const { loginUser, LoginError } = require('./auth/login');
const { changePassword, ChangePasswordError } = require('./auth/changePassword');
const {
  SESSION_COOKIE_NAME,
  deleteSession,
  findActiveSession,
} = require('./auth/sessions');
const { createRequireAuth } = require('./auth/requireAuth');
const {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  normalizeLanguage,
} = require('./auth/language');
const {
  isSupportedWeekStart,
  normalizeWeekStart,
} = require('./auth/weekStart');
const ExcelJS = require('exceljs');
const { parseSheet } = require('./trainingImport');
const { buildMacrocyclePrompt } = require('./prompts');
const {
  ShoeError,
  createShoe,
  getShoesByUserId,
  getShoeById,
  updateShoe,
  deleteShoe,
} = require('./shoes');
const {
  CycleError,
  getActiveCycle,
  createCycle,
  getCyclesByUserId,
  getCycleById,
  updateCycle,
  deleteCycle,
} = require('./cycles');
const { version: APP_VERSION } = require('../package.json');

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const FIELD_MAP = {
  tipo_treino: 'tipoTreino',
  treino_planejado: 'treinoPlanejado',
  fc_alvo: 'fcAlvo',
  tenis: 'tenis',
  fonte_fc: 'fonteFc',
  clima: 'clima',
  terreno: 'terreno',
  respiracao: 'respiracao',
  sensacao_muscular: 'sensacaoMuscular',
  energia_final: 'energiaFinal',
  dor_desconforto: 'dorDesconforto',
  feedback_livre: 'feedbackLivre',
};

function parseRpe(raw) {
  if (raw === undefined) return { ok: true, value: null };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    return { ok: false, error: 'rpe must be an integer between 1 and 5.' };
  }
  return { ok: true, value };
}

async function buildServer(options = {}) {
  const app = Fastify({ logger: false });
  await app.register(multipart, {
    limits: { fileSize: options.maxFileSizeBytes ?? MAX_FILE_BYTES },
  });
  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    index: false,
  });
  await app.register(fastifyCookie);

  const parseFile = options.parseFitFile || parseFitFile;
  const changeUserPassword = options.changeUserPassword || changePassword;

  const sessionOf = (request) => {
    if (!options.db) return null;
    return findActiveSession(options.db, request.cookies[SESSION_COOKIE_NAME]);
  };

  app.get('/', async (request, reply) => {
    const session = sessionOf(request);
    if (!session) {
      return reply.redirect('/login.html');
    }
    return reply.redirect('/home.html');
  });

  app.get('/home.html', async (request, reply) => {
    if (!sessionOf(request)) {
      return reply.redirect('/login.html');
    }
    return reply.sendFile('home.html');
  });

  app.get('/training-result.html', async (request, reply) => {
    if (!sessionOf(request)) {
      return reply.redirect('/login.html');
    }
    return reply.sendFile('training-result.html');
  });

  app.get('/calendar.html', async (request, reply) => {
    const session = sessionOf(request);
    if (!session) {
      return reply.redirect('/login.html');
    }
    if (!getActiveCycle(options.db, session.user.id)) {
      return reply.redirect('/cycles.html');
    }
    return reply.sendFile('calendar.html');
  });

  app.get('/ai-coach.html', async (request, reply) => {
    if (!sessionOf(request)) {
      return reply.redirect('/login.html');
    }
    return reply.sendFile('ai-coach.html');
  });

  app.get('/cycles.html', async (request, reply) => {
    if (!sessionOf(request)) {
      return reply.redirect('/login.html');
    }
    return reply.sendFile('cycles.html');
  });

  app.get('/login.html', async (request, reply) => {
    if (sessionOf(request)) {
      return reply.redirect('/');
    }
    return reply.sendFile('login.html');
  });

  app.get('/register.html', async (request, reply) => {
    if (sessionOf(request)) {
      return reply.redirect('/');
    }
    return reply.sendFile('register.html');
  });

  app.get('/api/version', async () => ({ version: APP_VERSION }));

  if (options.db) {
    const db = options.db;
    const requireAuth = createRequireAuth(db);

    app.post('/api/auth/register', async (request, reply) => {
      try {
        const user = await registerUser(db, request.body);
        return reply.code(201).send(user);
      } catch (error) {
        if (error instanceof RegistrationError) {
          return reply.code(error.status).send({ error: error.message });
        }
        throw error;
      }
    });

    app.post('/api/auth/login', async (request, reply) => {
      try {
        const { user, session } = await loginUser(db, request.body, {
          ttlMs: options.sessionTtlMs,
        });
        reply.setCookie(SESSION_COOKIE_NAME, session.token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: options.sessionCookieSecure ?? true,
          expires: new Date(session.expiresAt),
        });
        return reply.send({ user });
      } catch (error) {
        if (error instanceof LoginError) {
          return reply.code(error.status).send({ error: error.message });
        }
        throw error;
      }
    });

    app.post('/api/auth/logout', async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token) {
        deleteSession(db, token);
      }
      reply.clearCookie(SESSION_COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: options.sessionCookieSecure ?? true,
      });
      return { status: 'ok' };
    });

    app.get('/api/me', { preHandler: requireAuth }, async (request) => {
      return { user: request.user };
    });

    app.put('/api/auth/password', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const result = await changeUserPassword(db, request.user.id, request.body);
        return reply.send(result);
      } catch (error) {
        if (error instanceof ChangePasswordError) {
          const payload = { error: error.message };
          if (Array.isArray(error.errors) && error.errors.length > 0) {
            payload.errors = error.errors;
          }
          return reply.code(error.status).send(payload);
        }
        throw error;
      }
    });

    app.patch('/api/users/me/language', { preHandler: requireAuth }, async (request, reply) => {
      const requested = request.body?.preferred_lang;
      if (!isSupportedLanguage(requested)) {
        return reply.code(400).send({ error: 'Unsupported language.' });
      }
      const language = normalizeLanguage(requested);
      db.prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run(
        language,
        request.user.id
      );
      return { preferred_lang: language };
    });

    app.patch(
      '/api/users/me/calendar-preference',
      { preHandler: requireAuth },
      async (request, reply) => {
        const requested = request.body?.first_day_of_week;
        if (!isSupportedWeekStart(requested)) {
          return reply.code(400).send({ error: 'Unsupported week start.' });
        }
        const firstDay = normalizeWeekStart(requested);
        db.prepare('UPDATE users SET first_day_of_week = ? WHERE id = ?').run(
          firstDay,
          request.user.id
        );
        return { first_day_of_week: firstDay };
      }
    );

    app.get('/api/calendar/trainings', { preHandler: requireAuth }, async (request) => {
      const rawFrom = request.query?.from;
      const rawTo = request.query?.to;
      const from =
        typeof rawFrom === 'string' && rawFrom.trim() !== '' ? rawFrom.trim() : null;
      const to = typeof rawTo === 'string' && rawTo.trim() !== '' ? rawTo.trim() : null;
      const conditions = ['user_id = ?'];
      const params = [request.user.id];
      if (from) {
        conditions.push('dia >= ?');
        params.push(from);
      }
      if (to) {
        conditions.push('dia <= ?');
        params.push(to);
      }
      const trainings = db
        .prepare(
          `SELECT id, dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes,
                  fit_distance, fit_duration
           FROM trainings WHERE ${conditions.join(' AND ')} ORDER BY dia, id`
        )
        .all(...params);
      return { trainings };
    });

    app.post('/api/calendar/import', { preHandler: requireAuth }, async (request, reply) => {
      const activeCycle = getActiveCycle(db, request.user.id);
      if (!activeCycle) {
        return reply.code(400).send({ error: 'No active training cycle. Create one first.' });
      }

      if (!request.isMultipart()) {
        return reply.code(400).send({ error: 'Expected multipart/form-data upload.' });
      }

      let fileBuffer = null;
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file' && part.fieldname === 'file') {
            fileBuffer = await part.toBuffer();
          }
        }
      } catch (error) {
        request.log.warn(error);
        return reply.code(413).send({ error: 'File exceeds the size limit.' });
      }

      if (!fileBuffer) {
        return reply.code(400).send({ error: 'Missing spreadsheet file.' });
      }

      let workbook;
      try {
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(fileBuffer);
      } catch (error) {
        request.log.warn(error);
        return reply.code(400).send({
          error: 'Unsupported spreadsheet file. Please upload a valid .xlsx or .xls workbook.',
        });
      }

      const worksheet = workbook.worksheets[0];
      if (!worksheet) {
        return reply.code(400).send({ error: 'The spreadsheet has no sheets.' });
      }

      const { records, errors } = parseSheet(worksheet);
      if (errors.length > 0) {
        return reply.code(400).send({ errors });
      }
      if (records.length === 0) {
        return reply.code(400).send({ errors: [{ row: 1, col: 'Data', error: 'No training rows found.' }] });
      }

      const trainingSignature = (record) =>
        JSON.stringify([record.dia, record.treino, record.detalhes]);
      const existingSignatures = new Set(
        db
          .prepare('SELECT dia, treino, detalhes FROM trainings WHERE user_id = ?')
          .all(request.user.id)
          .map(trainingSignature)
      );
      const newRecords = records.filter((record) => {
        const signature = trainingSignature(record);
        if (existingSignatures.has(signature)) return false;
        existingSignatures.add(signature);
        return true;
      });

      const insert = db.prepare(
        `INSERT INTO trainings
           (user_id, training_cycle_id, dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertMany = db.transaction((rows) => {
        for (const record of rows) {
          insert.run(
            request.user.id,
            activeCycle.id,
            record.dia,
            record.periodo,
            record.tipo,
            record.treino,
            record.detalhes,
            record.fc_alvo,
            record.rpe,
            record.tenis,
            record.previsao,
            record.observacoes
          );
        }
      });
      insertMany(newRecords);

      return {
        imported: newRecords.length,
        skipped: records.length - newRecords.length,
      };
    });

    const TRAINING_COLUMNS =
      'id, dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes, feedback_rpe, feedback_notas, completed, has_smartwatch, feedback_shoe, feedback_hr_source, feedback_weather, feedback_terrain, feedback_breathing, feedback_muscle, feedback_energy, feedback_has_pain, feedback_pain, fit_duration, fit_distance, fit_avg_pace, fit_avg_hr, fit_max_hr, fit_elevation_gain, fit_summary_json';

    const findTraining = db.prepare(
      `SELECT ${TRAINING_COLUMNS} FROM trainings WHERE id = ? AND user_id = ?`
    );

    app.get('/api/trainings/:id', { preHandler: requireAuth }, async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'Invalid training id.' });
      }
      const training = findTraining.get(id, request.user.id);
      if (!training) {
        return reply.code(404).send({ error: 'Training not found.' });
      }
      return { training };
    });

    app.patch('/api/trainings/:id', { preHandler: requireAuth }, async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'Invalid training id.' });
      }

      const body = request.body ?? {};
      const updates = {};

      if (body.feedback_rpe !== undefined) {
        const parsed = parseRpe(body.feedback_rpe);
        if (!parsed.ok) {
          return reply.code(400).send({ error: parsed.error });
        }
        updates.feedback_rpe = parsed.value;
      }
      if (body.feedback_notas !== undefined) {
        if (body.feedback_notas !== null && typeof body.feedback_notas !== 'string') {
          return reply.code(400).send({ error: 'feedback_notas must be a string.' });
        }
        updates.feedback_notas =
          typeof body.feedback_notas === 'string' ? body.feedback_notas.trim() : null;
      }
      if (body.completed !== undefined) {
        if (typeof body.completed !== 'boolean') {
          return reply.code(400).send({ error: 'completed must be a boolean.' });
        }
        updates.completed = body.completed ? 1 : 0;
      }
      if (body.has_smartwatch !== undefined) {
        if (typeof body.has_smartwatch !== 'boolean') {
          return reply.code(400).send({ error: 'has_smartwatch must be a boolean.' });
        }
        updates.has_smartwatch = body.has_smartwatch ? 1 : 0;
      }
      if (body.feedback_has_pain !== undefined) {
        const value = body.feedback_has_pain;
        if (value !== null && value !== 'yes' && value !== 'no') {
          return reply.code(400).send({
            error: 'feedback_has_pain must be "yes", "no", or null.',
          });
        }
        updates.feedback_has_pain = value;
      }

      const FEEDBACK_TEXT_FIELDS = [
        'feedback_shoe',
        'feedback_hr_source',
        'feedback_weather',
        'feedback_terrain',
        'feedback_breathing',
        'feedback_muscle',
        'feedback_energy',
        'feedback_pain',
      ];
      for (const field of FEEDBACK_TEXT_FIELDS) {
        if (body[field] !== undefined) {
          if (body[field] !== null && typeof body[field] !== 'string') {
            return reply.code(400).send({ error: `${field} must be a string.` });
          }
          updates[field] =
            typeof body[field] === 'string' ? body[field].trim() : null;
        }
      }

      const fields = Object.keys(updates);
      if (fields.length === 0) {
        return reply.code(400).send({ error: 'No feedback fields provided.' });
      }

      if (!findTraining.get(id, request.user.id)) {
        return reply.code(404).send({ error: 'Training not found.' });
      }

      const assignments = fields.map((field) => `${field} = ?`).join(', ');
      db.prepare(
        `UPDATE trainings SET ${assignments} WHERE id = ? AND user_id = ?`
      ).run(...fields.map((field) => updates[field]), id, request.user.id);

      return { training: findTraining.get(id, request.user.id) };
    });

    app.post('/api/trainings/:id/fit', { preHandler: requireAuth }, async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'Invalid training id.' });
      }

      if (!findTraining.get(id, request.user.id)) {
        return reply.code(404).send({ error: 'Training not found.' });
      }

      if (!request.isMultipart()) {
        return reply.code(400).send({ error: 'Expected multipart/form-data upload.' });
      }

      let fileBuffer = null;
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file' && part.fieldname === 'file') {
            fileBuffer = await part.toBuffer();
          }
        }
      } catch (error) {
        request.log.warn(error);
        return reply.code(413).send({ error: 'File exceeds the size limit.' });
      }

      if (!fileBuffer) {
        return reply.code(400).send({ error: 'Missing .FIT file field.' });
      }

      try {
        const result = await parseFile(fileBuffer);
        const durationSec = result.totals?.durationSeconds || 0;
        const hours = Math.floor(durationSec / 3600);
        const minutes = Math.floor((durationSec % 3600) / 60);
        const seconds = Math.floor(durationSec % 60);
        const fitDuration = hours > 0
          ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
          : `${minutes}:${String(seconds).padStart(2, '0')}`;

        const fitDistance = result.totals?.distanceKm ?? 0;
        const fitAvgPace = result.totals?.avgPaceSecondsPerKm != null
          ? (result.totals.avgPaceSecondsPerKm / 60).toFixed(2)
          : null;
        const fitAvgHr = result.totals?.avgHeartRate ?? null;
        const fitMaxHr = result.totals?.maxHeartRate ?? null;
        const fitElevation = result.totals?.ascentMeters ?? null;
        const fitSummaryJson = JSON.stringify({
          activity: result.activity,
          totals: result.totals,
          laps: result.laps,
        });

        db.prepare(
          `UPDATE trainings SET
            fit_duration = ?,
            fit_distance = ?,
            fit_avg_pace = ?,
            fit_avg_hr = ?,
            fit_max_hr = ?,
            fit_elevation_gain = ?,
            fit_summary_json = ?
          WHERE id = ? AND user_id = ?`
        ).run(
          fitDuration,
          fitDistance,
          fitAvgPace,
          fitAvgHr,
          fitMaxHr,
          fitElevation,
          fitSummaryJson,
          id,
          request.user.id
        );

        return {
          fit_duration: fitDuration,
          fit_distance: fitDistance,
          fit_avg_pace: fitAvgPace,
          fit_avg_hr: fitAvgHr,
          fit_max_hr: fitMaxHr,
          fit_elevation_gain: fitElevation,
          laps: result.laps,
        };
      } catch (error) {
        request.log.error(error);
        return reply.code(422).send({
          error: 'Could not parse the .FIT file.',
          detail: error.message,
        });
      }
    });

    // ── Training Cycles CRUD ────────────────────────────────────
    app.get('/api/cycles', { preHandler: requireAuth }, async (request) => {
      const cycles = getCyclesByUserId(db, request.user.id);
      return { cycles };
    });

    app.get('/api/cycles/active', { preHandler: requireAuth }, async (request) => {
      const cycle = getActiveCycle(db, request.user.id);
      return { cycle: cycle || null };
    });

    app.post('/api/cycles', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const cycle = createCycle(db, request.user.id, request.body);
        return reply.code(201).send({ cycle });
      } catch (error) {
        if (error instanceof CycleError) {
          return reply.code(error.status).send({ error: error.message });
        }
        throw error;
      }
    });

    app.put('/api/cycles/:id', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const cycle = updateCycle(db, request.params.id, request.user.id, request.body);
        if (!cycle) {
          return reply.code(404).send({ error: 'Cycle not found.' });
        }
        return { cycle };
      } catch (error) {
        if (error instanceof CycleError) {
          return reply.code(error.status).send({ error: error.message });
        }
        throw error;
      }
    });

    app.delete('/api/cycles/:id', { preHandler: requireAuth }, async (request, reply) => {
      const deleted = deleteCycle(db, request.params.id, request.user.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Cycle not found.' });
      }
      return { status: 'ok' };
    });

    app.get('/api/cycles/:id/prompt', { preHandler: requireAuth }, async (request, reply) => {
      const cycle = getCycleById(db, request.params.id, request.user.id);
      if (!cycle) {
        return reply.code(404).send({ error: 'Cycle not found.' });
      }
      const lng = request.query.lng === 'pt' ? 'pt-BR' : (request.query.lng === 'en' ? 'en-US' : request.user.preferred_lang);
      const prompt = buildMacrocyclePrompt(cycle, lng);
      return { prompt };
    });

    // ── Shoes CRUD ──────────────────────────────────────────────
    app.get('/api/shoes', { preHandler: requireAuth }, async (request, reply) => {
      const shoes = getShoesByUserId(db, request.user.id);
      return { shoes };
    });

    app.post('/api/shoes', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const shoe = createShoe(db, request.user.id, request.body);
        return reply.code(201).send({ shoe });
      } catch (error) {
        if (error instanceof ShoeError) {
          return reply.code(error.status).send({ error: error.message });
        }
        throw error;
      }
    });

    app.put('/api/shoes/:id', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const shoe = updateShoe(db, request.params.id, request.user.id, request.body);
        if (!shoe) {
          return reply.code(404).send({ error: 'Shoe not found.' });
        }
        return { shoe };
      } catch (error) {
        if (error instanceof ShoeError) {
          return reply.code(error.status).send({ error: error.message });
        }
        throw error;
      }
    });

    app.delete('/api/shoes/:id', { preHandler: requireAuth }, async (request, reply) => {
      const deleted = deleteShoe(db, request.params.id, request.user.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Shoe not found.' });
      }
      return { status: 'ok' };
    });
  }

  app.post('/api/fit/parse', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: 'Expected multipart/form-data upload.' });
    }

    let fileBuffer = null;
    let fileName = '';
    const fields = {};

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          fileBuffer = await part.toBuffer();
          fileName = part.filename;
        } else {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (error) {
      request.log.warn(error);
      return reply.code(413).send({ error: 'File exceeds the size limit.' });
    }

    if (!fileBuffer) {
      return reply.code(400).send({ error: 'Missing .FIT file field.' });
    }

    if (!/\.fit$/i.test(fileName)) {
      return reply.code(400).send({ error: 'Only .FIT files are supported.' });
    }

    const rpeAlvo = parseRpe(fields.rpe_alvo);
    if (!rpeAlvo.ok) {
      return reply.code(400).send({ error: rpeAlvo.error });
    }

    const rpePercebido = parseRpe(fields.rpe_percebido);
    if (!rpePercebido.ok) {
      return reply.code(400).send({ error: rpePercebido.error });
    }

    try {
      const summary = await parseFile(fileBuffer);
      const feedback = {};
      for (const [fieldName, feedbackKey] of Object.entries(FIELD_MAP)) {
        feedback[feedbackKey] = fields[fieldName];
      }
      feedback.rpeAlvo = rpeAlvo.value;
      feedback.rpePercebido = rpePercebido.value;
      const lang = sessionOf(request)?.user.preferred_lang ?? DEFAULT_LANGUAGE;
      const markdown = generateMarkdown(summary, feedback, lang);
      return reply.send({
        fileName,
        sizeBytes: fileBuffer.length,
        activity: summary.activity,
        laps: summary.laps,
        totals: summary.totals,
        markdown,
      });
    } catch (error) {
      request.log.error(error);
      return reply.code(422).send({
        error: 'Could not read lap data from this .FIT file.',
        detail: error.message,
      });
    }
  });

  return app;
}

module.exports = { buildServer, parseRpe, MAX_FILE_BYTES };
