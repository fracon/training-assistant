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
} = require('./auth/sessions');
const { createRequireAuth } = require('./auth/requireAuth');

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
  await app.register(fastifyStatic, { root: path.join(__dirname, 'public') });
  await app.register(fastifyCookie);

  const parseFile = options.parseFitFile || parseFitFile;

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
      const markdown = generateMarkdown(summary, feedback);
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
