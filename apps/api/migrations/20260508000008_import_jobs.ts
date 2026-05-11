// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('import_jobs', (t) => {
    t.bigIncrements('id').primary();
    t.text('actor_user_id').notNullable();
    t.text('actor_display_name');
    t.text('status').notNullable().defaultTo('uploaded');
    // uploaded -> validating -> previewed -> executing -> succeeded|failed|partially_succeeded
    t.text('uploaded_filename');
    t.text('storage_ref'); // path or object key
    t.bigInteger('provider_id')
      .references('id')
      .inTable('directory_providers')
      .onDelete('SET NULL');
    t.jsonb('column_mapping_json').notNullable().defaultTo('{}');
    t.jsonb('options_json').notNullable().defaultTo('{}');
    t.timestamp('started_at', { useTz: true });
    t.timestamp('finished_at', { useTz: true });
    t.integer('row_count').notNullable().defaultTo(0);
    t.integer('success_count').notNullable().defaultTo(0);
    t.integer('failure_count').notNullable().defaultTo(0);
    t.text('result_file_ref');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['actor_user_id', 'created_at'], 'import_jobs_actor_idx');
    t.index(['status', 'created_at'], 'import_jobs_status_idx');
  });

  await knex.schema.createTable('import_row_results', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('import_job_id')
      .notNullable()
      .references('id')
      .inTable('import_jobs')
      .onDelete('CASCADE');
    t.integer('row_number').notNullable();
    t.text('result').notNullable(); // 'success' | 'failure' | 'skipped'
    t.text('error_code');
    t.text('error_message');
    t.text('target_dn');
    t.text('target_object_guid');
    t.jsonb('input_json'); // the parsed CSV row (with sensitive values redacted by app)
    t.jsonb('after_json'); // resulting AD object snapshot

    t.index(['import_job_id', 'row_number'], 'import_row_job_row_idx');
    t.index(['import_job_id', 'result'], 'import_row_job_result_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('import_row_results');
  await knex.schema.dropTableIfExists('import_jobs');
}
