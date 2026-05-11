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

export function createKysely(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
  });
}
