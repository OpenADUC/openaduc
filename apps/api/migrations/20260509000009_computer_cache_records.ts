// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('computer_cache_records', (t) => {
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
    t.text('dns_host_name');
    t.text('operating_system');
    t.text('operating_system_version');
    t.text('description');
    t.text('managed_by_dn');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('last_logon_at', { useTz: true });
    t.timestamp('password_last_set_at', { useTz: true });
    t.timestamp('created_at_source', { useTz: true });
    t.timestamp('modified_at_source', { useTz: true });
    t.timestamp('synced_at', { useTz: true });
    t.timestamp('stale_at', { useTz: true });
    t.timestamp('deleted_at', { useTz: true });
    t.jsonb('raw_attributes_json').notNullable().defaultTo('{}');

    t.unique(['provider_id', 'object_guid']);
  });

  await knex.raw(
    'CREATE INDEX computer_cache_provider_sam_idx ON computer_cache_records (provider_id, lower(sam_account_name))',
  );
  await knex.raw(
    'CREATE INDEX computer_cache_provider_name_idx ON computer_cache_records (provider_id, lower(name))',
  );
  await knex.raw(
    'CREATE INDEX computer_cache_provider_dns_idx ON computer_cache_records (provider_id, lower(dns_host_name))',
  );
  await knex.raw(
    'CREATE INDEX computer_cache_provider_dn_idx ON computer_cache_records (provider_id, distinguished_name)',
  );

  await knex.schema.alterTable('computer_cache_records', (t) => {
    t.index(['provider_id', 'enabled'], 'computer_cache_provider_enabled_idx');
    t.index(['provider_id', 'operating_system'], 'computer_cache_provider_os_idx');
    t.index(['provider_id', 'last_logon_at'], 'computer_cache_provider_lastlogon_idx');
  });

  await knex.raw(
    'CREATE INDEX computer_cache_name_trgm_idx ON computer_cache_records USING gin (name gin_trgm_ops)',
  );
  await knex.raw(
    'CREATE INDEX computer_cache_dns_trgm_idx ON computer_cache_records USING gin (dns_host_name gin_trgm_ops)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('computer_cache_records');
}
