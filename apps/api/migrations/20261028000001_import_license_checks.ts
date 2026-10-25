// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// The licenses an import's groups grant, checked in Entra once each
// person has synced. One row per import row whose groups grant any, with
// those groups and their SKUs as the license cache had them when the job
// was stored: whether the check waits (for the account, for Connect Sync,
// or for group-based licensing to settle), settled, or timed out, and
// each license's state and error as Entra last said. started_at and
// synced_at bound how long it waits for each. next_attempt_at and
// claim_token let any API process take a due check, and a process that
// dies holding one lets it go when its claim lapses.
//
// The table is new, so its indexes are built with it; the foreign keys
// take a brief lock on bulk_jobs and bulk_job_rows.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('import_license_checks', (t) => {
    t.bigInteger('row_id').primary().references('id').inTable('bulk_job_rows').onDelete('CASCADE');
    t.bigInteger('job_id').notNullable().references('id').inTable('bulk_jobs').onDelete('CASCADE');
    // [{ groupId, entraGroupId, name, skus: [{ skuId, skuPartNumber }] }]
    t.jsonb('expected').notNullable();
    t.text('status').notNullable().defaultTo('waiting');
    t.text('entra_user_id');
    // [{ skuId, skuPartNumber, group, state, error }], as Entra last said.
    t.jsonb('licenses');
    t.text('error_code');
    t.text('message');
    // When the account was first there to check, and when Entra first had it.
    t.timestamp('started_at', { useTz: true });
    t.timestamp('synced_at', { useTz: true });
    t.timestamp('checked_at', { useTz: true });
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('claim_token');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['job_id'], 'import_license_checks_job_idx');
  });
  await knex.raw(`
    ALTER TABLE import_license_checks
      ADD CONSTRAINT import_license_checks_status_check
        CHECK (status IN ('waiting', 'settled', 'timed_out'))
  `);
  await knex.raw(
    `CREATE INDEX import_license_checks_due_idx ON import_license_checks (next_attempt_at) WHERE status = 'waiting'`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('import_license_checks');
}
