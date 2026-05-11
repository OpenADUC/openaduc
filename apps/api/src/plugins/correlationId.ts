// SPDX-License-Identifier: BUSL-1.1
import fp from 'fastify-plugin';
import { v4 as uuid } from 'uuid';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

export default fp(async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-correlation-id'];
    const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : uuid();
    req.correlationId = id;
    reply.header('x-correlation-id', id);
  });
});
