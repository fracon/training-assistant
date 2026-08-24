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

  const sessionOf = (request) => {
    if (!options.db) return null;
    return findActiveSession(options.db, request.cookies[SESSION_COOKIE_NAME]);
  };

  app.get('/', async (request, reply) => {
    if (!sessionOf(request)) {
      return reply.redirect('/login.html');
    }
    return reply.sendFile('training-result.html');
  });

  app.get('/training-result.html', async (request, reply) => {
    if (!sessionOf(request)) {
      return reply.redirect('/login.html');
    }
    return reply.sendFile('training-result.html');
  });

  app.get('/calendar.html', async (request, reply) => {
    if (!sessionOf(request)) {
      return reply.redirect('/login.html');
    }
    return reply.sendFile('calendar.html');
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
      const trainings = db
        .prepare(
          `SELECT id, dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes
           FROM trainings WHERE user_id = ? ORDER BY dia, id`
        )
        .all(request.user.id);
      return { trainings };
    });

    app.post('/api/calendar/import', { preHandler: requireAuth }, async (request, reply) => {
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
        return reply.code(400).send({ errors: [{ row: 1, col: 'Dia', error: 'No training rows found.' }] });
      }

      const insert = db.prepare(
        `INSERT INTO trainings
           (user_id, dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertMany = db.transaction((rows) => {
        for (const record of rows) {
          insert.run(
            request.user.id,
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
      insertMany(records);

      return { imported: records.length };
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
