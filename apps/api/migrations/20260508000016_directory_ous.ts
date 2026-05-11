// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('directory_ous', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.text('distinguished_name').notNullable();
    t.text('name').notNullable();
    // Parent DN — null for the directory's base DN itself. Used to build the
    // tree view client-side without a recursive CTE.
    t.text('parent_dn');
    t.timestamp('synced_at', { useTz: true });
    t.timestamp('stale_at', { useTz: true });
    t.timestamp('deleted_at', { useTz: true });
    t.jsonb('raw_attributes_json').notNullable().defaultTo('{}');
  });

  await knex.raw(
    'CREATE UNIQUE INDEX directory_ous_provider_dn_idx ON directory_ous (provider_id, lower(distinguished_name))',
  );
  await knex.raw(
    'CREATE INDEX directory_ous_provider_parent_idx ON directory_ous (provider_id, parent_dn)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('directory_ous');
}
