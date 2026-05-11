// SPDX-License-Identifier: BUSL-1.1
import fp from 'fastify-plugin';
import type { Kysely } from 'kysely';
import type { Pool } from 'pg';
import { createDbPool, createKysely } from '../db/index.js';
import type { DB } from '../db/types.js';
import { loadEnv } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    pgPool: Pool;
    db: Kysely<DB>;
  }
}

export default fp(async (app) => {
  const env = loadEnv();
  const pool = createDbPool(env);
  const db = createKysely(pool);

  // node-postgres pools emit 'error' when an idle client dies (postgres
  // restart, network blip, failover). Without a listener, Node throws and
  // the api process exits — turning every db hiccup into a downtime window.
  pool.on('error', (err) => {
    app.log.error({ err }, 'idle pg client error (pool will reconnect on next checkout)');
  });

  app.decorate('pgPool', pool);
  app.decorate('db', db);

  app.addHook('onClose', async () => {
    await db.destroy();
    await pool.end();
  });
});
