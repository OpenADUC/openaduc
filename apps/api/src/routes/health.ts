// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', { config: { policy: { public: true } } }, async () => ({ status: 'ok' }));

  app.get('/health/ready', { config: { policy: { public: true } } }, async (req, reply) => {
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
    {
      config: { policy: { capability: 'configure:directory', stepUp: false, directory: 'caller' } },
    },
    async (req, reply) => {
      const provider = await app.services.providers.buildForRequest(req);
      const result = await provider.testConnection();
      if (!result.ok)
        return reply.status(503).send({ status: 'unavailable', message: result.message });
      return reply.send({ status: 'ok', message: result.message, details: result.details ?? {} });
    },
  );
}
