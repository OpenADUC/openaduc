// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Final cleanup of the pre-task-split scheduler. The previous migration
// (20260509000004_directory_sync_tasks) replaces the single-interval
// model; this one:
//   1. Copies any operator-configured cadence from the legacy
//      `sync_interval_minutes` column into the new `users.full` task
//      row, so the schedule the operator set carries over.
//   2. Drops the legacy `sync_*` columns and the supporting index.
//
// `sync_bind_upn` and `sync_bind_secret_encrypted` stay — the new
// scheduler still reads them for the per-task LDAP bind.
export async function up(knex: Knex): Promise<void> {
  // Backfill: write the legacy interval into directory_sync_tasks for
  // every directory that had one. ON CONFLICT preserves any existing
  // override (the new code may have already seeded a row before this
  // migration runs).
  await knex.raw(`
    INSERT INTO directory_sync_tasks (provider_id, task_key, enabled, interval_minutes)
    SELECT id, 'users.full', true, sync_interval_minutes
    FROM directory_providers
    WHERE sync_interval_minutes IS NOT NULL AND sync_interval_minutes > 0
    ON CONFLICT (provider_id, task_key) DO UPDATE
      SET interval_minutes = COALESCE(directory_sync_tasks.interval_minutes, EXCLUDED.interval_minutes);
  `);

  await knex.schema.alterTable('directory_providers', (t) => {
    t.dropIndex(
      ['sync_interval_minutes', 'sync_last_started_at'],
      'directory_providers_sync_due_idx',
    );
    t.dropColumn('sync_interval_minutes');
    t.dropColumn('sync_last_started_at');
    t.dropColumn('sync_last_finished_at');
    t.dropColumn('sync_last_status');
    t.dropColumn('sync_last_error');
    t.dropColumn('sync_users_seen');
    t.dropColumn('sync_groups_seen');
    t.dropColumn('sync_ous_seen');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Restore columns. Data is not recoverable — task-row state replaces
  // the legacy summary, and there's no symmetric "split-back" of values
  // that's meaningful.
  await knex.schema.alterTable('directory_providers', (t) => {
    t.integer('sync_interval_minutes');
    t.timestamp('sync_last_started_at', { useTz: true });
    t.timestamp('sync_last_finished_at', { useTz: true });
    t.text('sync_last_status');
    t.text('sync_last_error');
    t.integer('sync_users_seen');
    t.integer('sync_groups_seen');
    t.integer('sync_ous_seen');
    t.index(['sync_interval_minutes', 'sync_last_started_at'], 'directory_providers_sync_due_idx');
  });
}
