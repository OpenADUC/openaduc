// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// A row can be partial: some of its changes made, others failed (a user
// added to some of a job's groups but not all). The new check is added
// NOT VALID and validated separately, so the validating scan doesn't hold
// the lock that blocks the running jobs' writes.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE bulk_job_rows
      DROP CONSTRAINT bulk_job_rows_status_check,
      ADD CONSTRAINT bulk_job_rows_status_check
        CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'skipped'))
        NOT VALID
  `);
  await knex.raw('ALTER TABLE bulk_job_rows VALIDATE CONSTRAINT bulk_job_rows_status_check');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`UPDATE bulk_job_rows SET status = 'failed' WHERE status = 'partial'`);
  await knex.raw(`
    ALTER TABLE bulk_job_rows
      DROP CONSTRAINT bulk_job_rows_status_check,
      ADD CONSTRAINT bulk_job_rows_status_check
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped'))
  `);
}
