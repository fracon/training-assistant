'use strict';

const { SESSION_COOKIE_NAME, findActiveSession } = require('./sessions');

function createRequireAuth(db) {
  return async function requireAuth(request, reply) {
    const session = findActiveSession(db, request.cookies[SESSION_COOKIE_NAME]);
    if (!session) {
      return reply.code(401).send({ error: 'Authentication required.' });
    }
    request.session = session;
    request.user = session.user;
  };
}

module.exports = { createRequireAuth };
