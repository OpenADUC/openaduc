// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// The Entra groups that grant licences, as the entra.licenses.groups task
// last read them, so group pickers can badge a licensed group without
// asking Graph. Kept by Entra id, with the SID a synced group carries from
// AD: an AD group is matched by SID at read time, so a group the AD sync
// caches later still finds its licences. Cloud-only groups are kept too,
// to name the group a user's licence comes from.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('entra_group_licenses', (t) => {
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.text('entra_group_id').notNullable();
    t.text('display_name');
    t.text('on_premises_sid');
    // [{ skuId, skuPartNumber, disabledPlans }]
    t.jsonb('skus').notNullable().defaultTo('[]');
    t.timestamp('refreshed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['provider_id', 'entra_group_id']);
    t.index(['provider_id', 'on_premises_sid'], 'entra_group_licenses_sid_idx');
  });
  await knex.schema.alterTable('group_cache_records', (t) => {
    t.index(['provider_id', 'sid'], 'group_cache_records_sid_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('group_cache_records', (t) => {
    t.dropIndex(['provider_id', 'sid'], 'group_cache_records_sid_idx');
  });
  await knex.schema.dropTable('entra_group_licenses');
}
