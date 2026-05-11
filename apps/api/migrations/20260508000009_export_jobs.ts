// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('export_jobs', (t) => {
    t.bigIncrements('id').primary();
    t.text('actor_user_id').notNullable();
    t.text('actor_display_name');
    t.text('kind').notNullable(); // 'users' | 'audit-events' | 'groups'
    t.text('status').notNullable().defaultTo('pending');
    // pending|generating|ready|failed|expired
    t.bigInteger('provider_id')
      .references('id')
      .inTable('directory_providers')
      .onDelete('SET NULL');
    t.jsonb('filter_json').notNullable().defaultTo('{}');
    t.jsonb('columns_json').notNullable().defaultTo('[]');
    t.integer('row_count');
    t.timestamp('started_at', { useTz: true });
    t.timestamp('finished_at', { useTz: true });
    t.timestamp('expires_at', { useTz: true });
    t.text('file_ref'); // path / object key for generated artifact
    t.text('download_token_hash'); // sha256 of short-lived download token
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['actor_user_id', 'created_at'], 'export_jobs_actor_idx');
    t.index(['status', 'created_at'], 'export_jobs_status_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('export_jobs');
}
