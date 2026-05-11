// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // One row per individual task run. The directory_sync_tasks row keeps
  // only the latest result; this table keeps the full history so the
  // operator can see "ran 3× in the last 10 min, all failed with X".
  // Trimmed by an explicit cleanup later (or operator script) — for v1 we
  // don't auto-prune since the table is small (a few thousand rows per
  // year per task).
  await knex.schema.createTable('directory_sync_task_runs', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.text('task_key').notNullable();
    // 'running' | 'succeeded' | 'failed'. Matches directory_sync_tasks.last_status.
    t.text('status').notNullable();
    t.timestamp('started_at', { useTz: true }).notNullable();
    t.timestamp('finished_at', { useTz: true });
    // Duration in milliseconds. Computed at finish time so the UI
    // doesn't have to subtract two timestamps for every row.
    t.integer('duration_ms');
    t.text('error');
    t.jsonb('stats_json');
    // 'forced' = operator clicked Run now; 'cadence' = scheduler picked
    // it up because it was due. Surfaced in the history view so the
    // operator can tell "this ran because I clicked it" vs. routine.
    t.text('trigger').notNullable().defaultTo('cadence');
  });

  await knex.raw(
    'CREATE INDEX directory_sync_task_runs_provider_task_idx ON directory_sync_task_runs (provider_id, task_key, started_at DESC)',
  );
  await knex.raw(
    'CREATE INDEX directory_sync_task_runs_started_idx ON directory_sync_task_runs (started_at DESC)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('directory_sync_task_runs');
}
