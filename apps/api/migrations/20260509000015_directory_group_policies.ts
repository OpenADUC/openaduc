// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // GPC entries — one row per Group Policy Object. The list is small in
  // practice (rarely > 100 per domain), so we cache the whole shape returned
  // by the AD provider rather than promoting many columns. Fields used for
  // list display + the linked-policies lookup are surfaced; the rest is
  // available via raw_attributes_json for the detail view.
  await knex.schema.createTable('directory_group_policies', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.uuid('object_guid').notNullable();
    // Curly-braced GUID from the CN — what `gPLink` references.
    t.text('gpo_guid').notNullable();
    t.text('distinguished_name').notNullable();
    t.text('display_name');
    t.text('file_sys_path');
    t.integer('functionality_version');
    t.integer('version_number_raw');
    t.integer('user_version');
    t.integer('computer_version');
    t.integer('flags_raw');
    t.boolean('user_policy_enabled').notNullable().defaultTo(true);
    t.boolean('computer_policy_enabled').notNullable().defaultTo(true);
    t.text('wmi_filter_ref');
    // String arrays of CSE GUIDs. Stored as jsonb for portability.
    t.jsonb('computer_extension_guids').notNullable().defaultTo('[]');
    t.jsonb('user_extension_guids').notNullable().defaultTo('[]');
    t.timestamp('created_at_source', { useTz: true });
    t.timestamp('modified_at_source', { useTz: true });
    t.timestamp('synced_at', { useTz: true });
    t.timestamp('stale_at', { useTz: true });
    t.timestamp('deleted_at', { useTz: true });
    t.jsonb('raw_attributes_json').notNullable().defaultTo('{}');

    t.unique(['provider_id', 'object_guid']);
  });

  // gPLink scope ⇄ GPO mapping. Rebuilt wholesale on each policy sync — the
  // scope DN attribute is the source of truth and is small enough to
  // truncate-and-insert per provider.
  await knex.schema.createTable('directory_group_policy_links', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    // DN of the OU/domainDNS/site that carries the gPLink attribute.
    t.text('scope_dn').notNullable();
    // DN referenced inside the gPLink value — points at the GPC entry.
    t.text('gpo_dn').notNullable();
    // Curly-braced GUID extracted from gpo_dn's leading CN, joins to
    // directory_group_policies.gpo_guid.
    t.text('gpo_guid').notNullable();
    // 0-indexed position within the scope's gPLink string. Lower = higher
    // precedence given equal enforcement.
    t.integer('link_order').notNullable();
    t.integer('flags_raw').notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.boolean('enforced').notNullable().defaultTo(false);
    t.timestamp('synced_at', { useTz: true });
  });

  await knex.raw(
    'CREATE INDEX directory_gpo_provider_dn_idx ON directory_group_policies (provider_id, lower(distinguished_name))',
  );
  await knex.raw(
    'CREATE INDEX directory_gpo_provider_guid_idx ON directory_group_policies (provider_id, lower(gpo_guid))',
  );
  await knex.raw(
    'CREATE INDEX directory_gpo_links_provider_scope_idx ON directory_group_policy_links (provider_id, lower(scope_dn))',
  );
  await knex.raw(
    'CREATE INDEX directory_gpo_links_provider_guid_idx ON directory_group_policy_links (provider_id, lower(gpo_guid))',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('directory_group_policy_links');
  await knex.schema.dropTableIfExists('directory_group_policies');
}
