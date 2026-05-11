// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('sync_jobs', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.text('status').notNullable().defaultTo('pending'); // pending|running|succeeded|failed
    t.text('trigger').notNullable().defaultTo('scheduled'); // 'scheduled' | 'manual'
    t.text('triggered_by_actor_id'); // null for scheduled
    t.timestamp('started_at', { useTz: true });
    t.timestamp('finished_at', { useTz: true });
    t.integer('users_seen').notNullable().defaultTo(0);
    t.integer('groups_seen').notNullable().defaultTo(0);
    t.integer('memberships_seen').notNullable().defaultTo(0);
    t.integer('errors_count').notNullable().defaultTo(0);
    t.jsonb('error_summary_json').notNullable().defaultTo('[]');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['provider_id', 'started_at'], 'sync_jobs_provider_started_idx');
    t.index(['status', 'started_at'], 'sync_jobs_status_started_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sync_jobs');
}
