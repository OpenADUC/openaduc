// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('group_cache_records', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.uuid('object_guid').notNullable();
    t.text('sid');
    t.text('distinguished_name').notNullable();
    t.text('sam_account_name');
    t.text('name');
    t.text('description');
    t.text('group_type'); // security/distribution
    t.text('group_scope'); // global/universal/domain-local
    t.timestamp('synced_at', { useTz: true });
    t.timestamp('stale_at', { useTz: true });
    t.timestamp('deleted_at', { useTz: true });
    t.jsonb('raw_attributes_json').notNullable().defaultTo('{}');

    t.unique(['provider_id', 'object_guid']);
  });

  await knex.raw(
    'CREATE INDEX group_cache_provider_sam_idx ON group_cache_records (provider_id, lower(sam_account_name))',
  );
  await knex.raw(
    'CREATE INDEX group_cache_provider_name_idx ON group_cache_records (provider_id, lower(name))',
  );
  await knex.raw(
    'CREATE INDEX group_cache_provider_dn_idx ON group_cache_records (provider_id, distinguished_name)',
  );
  await knex.raw(
    'CREATE INDEX group_cache_name_trgm_idx ON group_cache_records USING gin (name gin_trgm_ops)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('group_cache_records');
}
