// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (req, reply) => {
    try {
      await sql`select 1`.execute(app.db);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      req.log.error({ err }, 'readiness check failed');
      return reply.status(503).send({ status: 'unavailable', db: 'unreachable' });
    }
  });

  // Admin-only LDAPS bind test against the configured provider.
  app.get(
    '/health/directory',
    { preHandler: app.requireCapability('configure:directory') },
    async (req, reply) => {
      const provider = await app.services.providers.buildForRequest(req);
      const result = await provider.testConnection();
      if (!result.ok)
        return reply.status(503).send({ status: 'unavailable', message: result.message });
      return reply.send({ status: 'ok', message: result.message, details: result.details ?? {} });
    },
  );
}
