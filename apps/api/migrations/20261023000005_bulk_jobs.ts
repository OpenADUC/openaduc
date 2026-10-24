// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Bulk actions run as server-side jobs: one bulk_jobs row per job, one
// bulk_job_rows row per object it acts on, and every audit event the job
// writes carries its id so the audit log can group them (the index on it
// is built concurrently by the next migration). No password is stored
// here: a job runs on its operator's elevated session.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bulk_jobs', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.text('action').notNullable();
    t.text('status').notNullable();
    t.text('pause_reason');
    // Set by the run that claims the job; only that run may change it.
    t.uuid('run_token');

    t.text('actor_user_id').notNullable();
    t.text('actor_display_name');
    t.text('actor_username').notNullable();
    // The session whose elevated session the job writes with; moves when the
    // operator continues or retries it from another session.
    t.uuid('admin_session_id').notNullable();
    // Request context for the audit events, from the latest start.
    t.text('source_ip');
    t.text('user_agent');
    t.text('correlation_id');

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('heartbeat_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true });

    t.index(['provider_id', 'actor_user_id', 'created_at'], 'bulk_jobs_actor_idx');
    t.index(['status', 'heartbeat_at'], 'bulk_jobs_status_idx');
  });

  await knex.schema.createTable('bulk_job_rows', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('job_id').notNullable().references('id').inTable('bulk_jobs').onDelete('CASCADE');
    t.integer('ordinal').notNullable();
    t.text('target_id').notNullable();
    t.text('target_dn');
    t.text('target_name');
    t.text('status').notNullable().defaultTo('pending');
    // The run that claimed the row, so a stale run can't record over a newer one.
    t.uuid('run_token');
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('error_code');
    t.text('error_message');
    t.jsonb('input_json');
    t.jsonb('before_json');
    t.jsonb('after_json');
    t.timestamp('started_at', { useTz: true });
    t.timestamp('finished_at', { useTz: true });

    t.unique(['job_id', 'ordinal'], { indexName: 'bulk_job_rows_job_ordinal_uq' });
    t.index(['job_id', 'status'], 'bulk_job_rows_job_status_idx');
  });

  await knex.raw(`
    ALTER TABLE bulk_jobs
      ADD CONSTRAINT bulk_jobs_status_check
        CHECK (status IN ('queued', 'running', 'paused', 'finished', 'cancelled')),
      ADD CONSTRAINT bulk_jobs_pause_reason_check
        CHECK (pause_reason IN ('step_up_required', 'interrupted', 'directory_unavailable'))
  `);
  await knex.raw(`
    ALTER TABLE bulk_job_rows
      ADD CONSTRAINT bulk_job_rows_status_check
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped'))
  `);

  // Not a foreign key: audit rows outlive whatever they describe. A
  // nullable column without a default is a catalogue change only.
  await knex.schema.alterTable('audit_events', (t) => {
    t.bigInteger('bulk_job_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('audit_events', (t) => {
    t.dropColumn('bulk_job_id');
  });
  await knex.schema.dropTableIfExists('bulk_job_rows');
  await knex.schema.dropTableIfExists('bulk_jobs');
}
