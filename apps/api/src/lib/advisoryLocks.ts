// SPDX-License-Identifier: BUSL-1.1
// Every Postgres advisory lock OpenADUC takes, in one place so two features
// can't pick the same key by accident.
import type { Pool } from 'pg';

/** First-run setup: one setup at a time across every API process. */
export const SETUP_LOCK_KEY = 0x0add_5e7;

/**
 * Per-directory sync: first key of the two-key form (the second is the
 * directory id), so tasks for one directory never run in two processes.
 */
export const SYNC_LOCK_CLASS = 0x0ad0;

/**
 * Run `fn` holding a session-level advisory lock, waiting for it if
 * another session has it. The lock's connection comes from `lockPool`
 * (app.pgLockPool), never from the pool `fn`'s own queries use: holding
 * one of those while `fn` needs another can exhaust the pool.
 */
export async function withAdvisoryLock<T>(
  lockPool: Pool,
  key: number,
  fn: () => Promise<T>,
): Promise<T> {
  const conn = await lockPool.connect();
  try {
    await conn.query('select pg_advisory_lock($1)', [key]);
    try {
      return await fn();
    } finally {
      await conn.query('select pg_advisory_unlock($1)', [key]);
    }
  } finally {
    conn.release();
  }
}
