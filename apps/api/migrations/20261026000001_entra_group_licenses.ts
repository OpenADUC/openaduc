// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// The Entra groups that grant licenses, as the entra.licenses.groups task
// last read them, so group pickers can badge a licensed group without
// asking Graph. Kept by Entra id with the SID a synced group carries from
// AD; cloud-only groups are kept too. When the task last read them is its
// run history's to say.
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
    // [{ skuId, skuPartNumber, disabledPlanCount }]
    t.jsonb('skus').notNullable().defaultTo('[]');
    t.primary(['provider_id', 'entra_group_id']);
    t.index(['provider_id', 'on_premises_sid'], 'entra_group_licenses_sid_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('entra_group_licenses');
}
