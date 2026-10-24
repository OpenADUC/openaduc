// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Placement rules: where an import last put the bucket of rows sharing a
// value in the column it grouped by, so the next import with that value
// starts there. One per directory, column and value, the value compared
// without case or surrounding spaces (value_key). Groups are kept by
// objectGUID, so a renamed group stays in its rule.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('import_placement_rules', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.text('grouping_column').notNullable();
    t.text('value_key').notNullable();
    // As the operator's spreadsheet last wrote it.
    t.text('value').notNullable();
    t.text('ou_dn').notNullable();
    t.jsonb('group_ids').notNullable().defaultTo('[]');
    t.text('updated_by');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['provider_id', 'grouping_column', 'value_key'], {
      indexName: 'import_placement_rules_value_uq',
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('import_placement_rules');
}
