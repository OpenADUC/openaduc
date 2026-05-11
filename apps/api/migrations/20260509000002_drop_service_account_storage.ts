// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// We no longer store directory bind credentials. Every operation binds as
// the logged-in user (login password cached in process memory for reads;
// step-up password cached for writes). Drop the unused columns + the
// sync/import/export job tables that the now-deleted worker owned.
export async function up(knex: Knex): Promise<void> {
  // The worker's tables. Background sync goes away with the service
  // account — caches populate live as users browse.
  await knex.schema.dropTableIfExists('import_row_results');
  await knex.schema.dropTableIfExists('import_jobs');
  await knex.schema.dropTableIfExists('export_jobs');
  await knex.schema.dropTableIfExists('sync_jobs');

  await knex.schema.alterTable('directory_providers', (t) => {
    t.dropColumn('bind_dn_ref');
    t.dropColumn('bind_secret_encrypted');
  });
}

export async function down(_knex: Knex): Promise<void> {
  // Irreversible — re-running setup would re-create the directory rows
  // anyway. Keeping `down` as a no-op is intentional: the previous shape
  // doesn't make sense without the worker.
}
