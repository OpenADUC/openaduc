// SPDX-License-Identifier: BUSL-1.1
import Fastify from 'fastify';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('db plugin', () => {
  beforeEach(() => {
    vi.stubEnv('SESSION_COOKIE_SECRET', 'x'.repeat(32));
    vi.stubEnv('ENCRYPTION_KEY', 'test-key');
    // The pool only connects on first checkout, so no database is needed.
    vi.stubEnv('DATABASE_URL', 'postgres://openaduc:openaduc@127.0.0.1:1/openaduc');
    vi.stubEnv('DATABASE_POOL_MIN', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('closes cleanly after the pool has been used', async () => {
    const { default: dbPlugin } = await import('./db.js');
    const app = Fastify({ logger: false });
    await app.register(dbPlugin);
    await app.ready();
    // Kysely only takes ownership of the pool once a query has initialised its
    // driver, as every request does in production. Nothing listens on port 1,
    // so the query fails fast, but the driver is initialised.
    await sql`select 1`.execute(app.db).catch(() => undefined);

    await expect(app.close()).resolves.toBeUndefined();
    expect(app.pgPool.ended).toBe(true);
  });

  it('ends the pool on shutdown when no query ever ran', async () => {
    const { default: dbPlugin } = await import('./db.js');
    const app = Fastify({ logger: false });
    await app.register(dbPlugin);
    await app.ready();

    await expect(app.close()).resolves.toBeUndefined();
    expect(app.pgPool.ended).toBe(true);
  });
});
