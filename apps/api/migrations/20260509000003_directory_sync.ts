// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Re-introduce a service account — but scoped tightly: it exists ONLY for
// background sync. Per-session reads still bind as the logged-in operator.
// `sync_interval_minutes` null/0 means manual-only; the scheduler ignores
// the row. `sync_last_*` columns capture the most recent run for the UI.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('directory_providers', (t) => {
    t.text('sync_bind_upn');
    t.text('sync_bind_secret_encrypted');
    t.integer('sync_interval_minutes');
    t.timestamp('sync_last_started_at', { useTz: true });
    t.timestamp('sync_last_finished_at', { useTz: true });
    // 'succeeded' | 'failed' | 'running'. Null = never run.
    t.text('sync_last_status');
    t.text('sync_last_error');
    t.integer('sync_users_seen');
    t.integer('sync_groups_seen');
    t.integer('sync_ous_seen');
  });

  // Lets the scheduler cheaply find directories that are due to run.
  await knex.schema.alterTable('directory_providers', (t) => {
    t.index(['sync_interval_minutes', 'sync_last_started_at'], 'directory_providers_sync_due_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('directory_providers', (t) => {
    t.dropIndex(
      ['sync_interval_minutes', 'sync_last_started_at'],
      'directory_providers_sync_due_idx',
    );
    t.dropColumn('sync_bind_upn');
    t.dropColumn('sync_bind_secret_encrypted');
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
