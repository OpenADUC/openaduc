// SPDX-License-Identifier: BUSL-1.1
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Env } from '../config/env.js';
import type { DB } from './types.js';

export function createDbPool(env: Env): pg.Pool {
  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    min: env.DATABASE_POOL_MIN,
    max: env.DATABASE_POOL_MAX,
  });
}

/**
 * Connections that only hold session-level advisory locks for as long as a
 * job runs. Kept apart from the main pool: a job holding one main-pool
 * connection while its queries wait for others could exhaust it, and then
 * every job and request stalls.
 */
export function createLockPool(env: Env): pg.Pool {
  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    min: 0,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 10_000,
  });
}

export function createKysely(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
  });
}
