// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Surface AD's DONT_EXPIRE_PASSWORD UAC bit (0x10000) at the cache layer so
// the UI can flag service accounts and "never expires" accounts without
// re-parsing UAC on every read. Filter index for the saved-views feature.
//
// Also seeds two new app_settings keys that operators set in the Settings
// page: an org-wide password rotation override (used when AD's own
// max-password-age policy is permissive or unreadable) and a "stale logon"
// threshold for the saved view that flags dormant accounts.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_cache_records', (t) => {
    t.boolean('password_never_expires').notNullable().defaultTo(false);
  });
  await knex.raw(
    'CREATE INDEX user_cache_provider_pwd_never_expires_idx ON user_cache_records (provider_id, password_never_expires)',
  );

  // Seed defaults for the new policy / view settings (idempotent).
  await knex.raw(
    `INSERT INTO app_settings (key, value_json, description) VALUES
       ('directory.password_max_age_days', NULL,
        'Optional org-wide password rotation override in days. When set, the API computes passwordExpiresAt = passwordLastSetAt + N days for accounts without DONT_EXPIRE_PASSWORD. Null = use AD policy as-is.'),
       ('view.password_expiring_days', '14'::jsonb,
        'Default window for the password-expiring saved view, in days.'),
       ('view.stale_logon_days', '60'::jsonb,
        'Default threshold for the stale-logon saved view, in days since last logon.')
     ON CONFLICT (key) DO NOTHING`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS user_cache_provider_pwd_never_expires_idx');
  await knex.schema.alterTable('user_cache_records', (t) => {
    t.dropColumn('password_never_expires');
  });
  await knex.raw(
    `DELETE FROM app_settings WHERE key IN
       ('directory.password_max_age_days',
        'view.password_expiring_days',
        'view.stale_logon_days')`,
  );
}
