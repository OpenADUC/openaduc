// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// A revert is a bulk job that puts back another job's before-values; it
// points at the job it reverts, which can't go while the revert stays (a
// revert's rows only run knowing it). A nullable column without a default
// is a catalogue change; checking the new foreign key reads bulk_jobs,
// one row per job, so the lock is brief. Its indexes are built
// concurrently by the next migration.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE bulk_jobs ADD COLUMN reverts_job_id bigint REFERENCES bulk_jobs (id)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE bulk_jobs DROP COLUMN reverts_job_id');
}
