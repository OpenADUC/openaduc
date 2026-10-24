// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// A revert is a bulk job that puts back another job's before-values; it
// points at the job it reverts, which can't go while the revert stays (a
// revert's rows only run knowing that). The column is nullable without a default,
// a catalogue change only; the foreign key is added NOT VALID and
// validated separately, so the validating scan doesn't hold the lock that
// blocks running jobs' writes. Its indexes are built concurrently by the
// next migration.
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE bulk_jobs ADD COLUMN reverts_job_id bigint');
  await knex.raw(`
    ALTER TABLE bulk_jobs
      ADD CONSTRAINT bulk_jobs_reverts_job_id_fk
        FOREIGN KEY (reverts_job_id) REFERENCES bulk_jobs (id)
        NOT VALID
  `);
  await knex.raw('ALTER TABLE bulk_jobs VALIDATE CONSTRAINT bulk_jobs_reverts_job_id_fk');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE bulk_jobs DROP COLUMN reverts_job_id');
}
