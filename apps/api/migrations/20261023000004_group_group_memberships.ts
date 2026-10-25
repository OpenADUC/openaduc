// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Groups nested directly in other groups, the group→group counterpart of
// user_group_memberships. Rebuilt with it from each cached group's `member`.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('group_group_memberships', (t) => {
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.uuid('group_object_guid').notNullable();
    t.uuid('member_group_object_guid').notNullable();
    t.timestamp('synced_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.primary(['provider_id', 'group_object_guid', 'member_group_object_guid']);
  });

  // Fill it from the cache now, so member lists and counts include nested
  // groups straight after the upgrade rather than after the next rebuild.
  await knex.raw(`
    INSERT INTO group_group_memberships (provider_id, group_object_guid, member_group_object_guid)
    SELECT g.provider_id, g.object_guid, m.object_guid
    FROM group_cache_records g
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE
      WHEN jsonb_typeof(g.raw_attributes_json -> 'member') = 'array' THEN g.raw_attributes_json -> 'member'
      WHEN g.raw_attributes_json -> 'member' IS NOT NULL THEN jsonb_build_array(g.raw_attributes_json -> 'member')
      ELSE '[]'::jsonb
    END) AS member_dn
    JOIN group_cache_records m
      ON m.provider_id = g.provider_id
      AND lower(m.distinguished_name) = lower(member_dn)
    WHERE g.deleted_at IS NULL
      AND m.deleted_at IS NULL
    ON CONFLICT DO NOTHING
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('group_group_memberships');
}
