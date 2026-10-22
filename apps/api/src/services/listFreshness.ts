// SPDX-License-Identifier: BUSL-1.1
import type { ListFreshness } from '@openaduc/shared';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { TASK_REGISTRY } from './syncTasks/registry.js';
import type { SyncTaskKey } from './syncTasks/types.js';

const TASKS = {
  users: ['users.delta', 'users.full'],
  groups: ['groups.delta', 'groups.full'],
  computers: ['computers.delta', 'computers.full'],
} as const satisfies Record<string, readonly SyncTaskKey[]>;

/**
 * When a cached list last synced successfully, and whether that's overdue:
 * older than twice its delta task's interval (at least an hour). Uses sync
 * run history, not cache timestamps: a delta that finds nothing changed
 * writes no rows but still means the list is current.
 */
export async function listFreshness(
  db: Kysely<DB>,
  providerId: number,
  list: keyof typeof TASKS,
): Promise<ListFreshness> {
  const [delta] = TASKS[list];
  const [lastRun, task] = await Promise.all([
    db
      .selectFrom('directory_sync_task_runs')
      .select((eb) => eb.fn.max('finished_at').as('finished_at'))
      .where('provider_id', '=', providerId)
      .where('task_key', 'in', [...TASKS[list]])
      .where('status', '=', 'succeeded')
      .executeTakeFirst(),
    db
      .selectFrom('directory_sync_tasks')
      .select('interval_minutes')
      .where('provider_id', '=', providerId)
      .where('task_key', '=', delta)
      .executeTakeFirst(),
  ]);
  const lastSyncedAt = lastRun?.finished_at ? new Date(lastRun.finished_at) : null;
  const intervalMinutes = task?.interval_minutes ?? TASK_REGISTRY[delta].defaultIntervalMinutes;
  const allowedMs = Math.max(2 * intervalMinutes, 60) * 60_000;
  return {
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    stale: !lastSyncedAt || Date.now() - lastSyncedAt.getTime() > allowedMs,
  };
}
