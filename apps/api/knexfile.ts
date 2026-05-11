// SPDX-License-Identifier: BUSL-1.1
import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Knex } from 'knex';

// Walk upward to find a workspace .env (same logic as src/config/env.ts).
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, '../../.env'),
  path.resolve(here, '.env'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of candidates) {
  if (existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run knex migrations');
}

const config: Knex.Config = {
  client: 'pg',
  connection: databaseUrl,
  pool: {
    min: Number(process.env.DATABASE_POOL_MIN ?? 2),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  },
  migrations: {
    directory: './migrations',
    extension: 'ts',
    loadExtensions: ['.ts', '.js'],
    tableName: 'knex_migrations',
  },
};

export default config;
