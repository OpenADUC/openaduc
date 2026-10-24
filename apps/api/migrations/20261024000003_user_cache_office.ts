// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// The office (physicalDeliveryOfficeName) gets its own cache column: it's
// kept out of the raw attributes, and a bulk edit's preview reads it.
// Rows cached before this don't have it, so office_read says whether a
// row's office has been read; the next full sync is made due now, so it
// reads every user's soon rather than at its next scheduled run. Constant
// defaults, so adding the columns doesn't rewrite the table.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_cache_records', (t) => {
    t.text('office');
    t.boolean('office_read').notNullable().defaultTo(false);
  });
  await knex('directory_sync_tasks')
    .where({ task_key: 'users.full' })
    .whereRaw("last_status IS DISTINCT FROM 'running'")
    .update({ last_started_at: null });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_cache_records', (t) => {
    t.dropColumn('office_read');
    t.dropColumn('office');
  });
}
