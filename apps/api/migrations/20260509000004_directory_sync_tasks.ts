// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Per-task scheduler state. Replaces the single-interval model on
// directory_providers (sync_interval_minutes / sync_last_*). One row per
// (directory, task_key); rows are seeded lazily by the scheduler from the
// task registry, so adding a new task type doesn't need a migration.
//
// last_cursor is opaque to the scheduler: a *.delta runner stores an ISO
// timestamp, a future DirSync runner would store a cookie, etc. Only the
// runner interprets it.
//
// anchor_at is optional. When null, the task is "due" by elapsed time
// since last_started_at (today's behavior). When set, it pins the slot
// boundaries: due when slot = anchor + floor((now-anchor)/interval)*interval
// is in the past and last_started_at < slot.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('directory_sync_tasks', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.text('task_key').notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    // null = inherit registry default. 0 is not used (would be ambiguous
    // with "disabled"); operators disable a task via `enabled = false`.
    t.integer('interval_minutes');
    t.timestamp('anchor_at', { useTz: true });
    t.timestamp('last_started_at', { useTz: true });
    t.timestamp('last_finished_at', { useTz: true });
    t.text('last_status'); // 'running' | 'succeeded' | 'failed' | null
    t.text('last_error');
    t.text('last_cursor'); // opaque per runner
    t.jsonb('last_stats_json');
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['provider_id', 'task_key']);
    t.index(['enabled', 'last_started_at'], 'directory_sync_tasks_due_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('directory_sync_tasks');
}
