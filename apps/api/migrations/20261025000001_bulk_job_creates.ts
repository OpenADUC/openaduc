// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// An import is a bulk job whose rows create their accounts, so a row has
// no target until its account exists, and a row whose manager the import
// creates runs after that manager's row (after_ordinal). Dropping NOT NULL
// and adding nullable columns without defaults are catalogue changes only.
//
// The passwords an import hands out in its results CSV are held, encrypted
// with the app's secret key, in import_passwords until the operator
// downloads the CSV (once; results_downloaded_at) or 24 hours pass. A row
// without row_id is the one password every row of a job gets. The table is
// new, so its indexes are built with it; its foreign keys take a brief lock
// on bulk_jobs and bulk_job_rows.
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE bulk_job_rows ALTER COLUMN target_id DROP NOT NULL');
  await knex.raw('ALTER TABLE bulk_job_rows ADD COLUMN after_ordinal integer');
  await knex.raw('ALTER TABLE bulk_jobs ADD COLUMN results_downloaded_at timestamptz');

  await knex.schema.createTable('import_passwords', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('job_id').notNullable().references('id').inTable('bulk_jobs').onDelete('CASCADE');
    t.bigInteger('row_id').references('id').inTable('bulk_job_rows').onDelete('CASCADE');
    t.text('password_enc').notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['expires_at'], 'import_passwords_expiry_idx');
  });
  await knex.raw(
    'CREATE UNIQUE INDEX import_passwords_row_uq ON import_passwords (row_id) WHERE row_id IS NOT NULL',
  );
  await knex.raw(
    'CREATE UNIQUE INDEX import_passwords_job_uq ON import_passwords (job_id) WHERE row_id IS NULL',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('import_passwords');
  await knex.raw('ALTER TABLE bulk_jobs DROP COLUMN results_downloaded_at');
  await knex.raw('ALTER TABLE bulk_job_rows DROP COLUMN after_ordinal');
  // Imports' rows can't be kept without a target.
  await knex.raw(`DELETE FROM bulk_jobs WHERE action = 'user.create'`);
  await knex.raw('ALTER TABLE bulk_job_rows ALTER COLUMN target_id SET NOT NULL');
}
