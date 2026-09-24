'use strict';

function createRequireAdmin() {
  return async function requireAdmin(request, reply) {
    if (!request.user) {
      return reply.code(401).send({ error: 'Authentication required.' });
    }
    if (request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Administrator access required.' });
    }
  };
}

module.exports = { createRequireAdmin };
