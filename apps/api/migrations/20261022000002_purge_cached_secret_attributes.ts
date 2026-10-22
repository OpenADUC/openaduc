// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Same list as SECRET_ATTRS in providers/active-directory/normalize.ts, which
// now strips these before anything is cached. Copied, not imported: a
// migration must keep doing what it did when it shipped.
const SECRET_ATTRS = [
  'ms-mcs-admpwd',
  'mslaps-password',
  'mslaps-encryptedpassword',
  'mslaps-encryptedpasswordhistory',
  'mslaps-encrypteddsrmpassword',
  'mslaps-encrypteddsrmpasswordhistory',
  'msds-managedpassword',
  'unicodepwd',
  'userpassword',
  'supplementalcredentials',
  'msfve-recoverypassword',
];

const TABLES = [
  'user_cache_records',
  'group_cache_records',
  'computer_cache_records',
  'directory_group_policies',
  'directory_ous',
];

export async function up(knex: Knex): Promise<void> {
  // Syncs read every attribute the service account could see, so caches may
  // hold LAPS passwords and similar in plaintext. Drop those keys, matching
  // names case-insensitively as LDAP does.
  for (const table of TABLES) {
    await knex.raw(
      `UPDATE ?? SET raw_attributes_json = (
         SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
         FROM jsonb_each(raw_attributes_json)
         WHERE lower(key) <> ALL(?::text[])
       )
       WHERE EXISTS (
         SELECT 1 FROM jsonb_object_keys(raw_attributes_json) AS k
         WHERE lower(k) = ANY(?::text[])
       )`,
      [table, SECRET_ATTRS, SECRET_ATTRS],
    );
  }
}

export async function down(): Promise<void> {
  // Deleted secrets can't be restored, and shouldn't be.
}
