// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// A license check that can't go on ends `stopped` (replacing `timed_out`)
// with why in error_code: past its deadline (waiting for sync, or for
// licensing to settle), the feature turned off, Graph refusing, or a row
// that joined no licensed group. error_code is typed by a CHECK. The
// table is new and small, so the rewrite and the constraints are instant.
const CODES = [
  'unsynced',
  'throttled',
  'graph_refused',
  'graph_unavailable',
  'directory_unavailable',
  'internal_error',
  'licenses_off',
  'not_in_groups',
  'not_created',
  'sync_timeout',
  'settle_timeout',
];

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE import_license_checks DROP CONSTRAINT import_license_checks_status_check',
  );
  await knex.raw(`
    UPDATE import_license_checks
       SET status = 'stopped',
           error_code = CASE WHEN synced_at IS NULL THEN 'sync_timeout' ELSE 'settle_timeout' END
     WHERE status = 'timed_out'
  `);
  await knex.raw(
    `UPDATE import_license_checks SET error_code = 'internal_error' WHERE error_code = 'read_failed'`,
  );
  await knex.raw(`
    ALTER TABLE import_license_checks
      ADD CONSTRAINT import_license_checks_status_check
        CHECK (status IN ('waiting', 'settled', 'stopped')),
      ADD CONSTRAINT import_license_checks_error_code_check
        CHECK (error_code IS NULL OR error_code IN (${CODES.map((c) => `'${c}'`).join(', ')}))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE import_license_checks
      DROP CONSTRAINT import_license_checks_status_check,
      DROP CONSTRAINT import_license_checks_error_code_check
  `);
  await knex.raw(`UPDATE import_license_checks SET status = 'timed_out' WHERE status = 'stopped'`);
  await knex.raw(`
    ALTER TABLE import_license_checks
      ADD CONSTRAINT import_license_checks_status_check
        CHECK (status IN ('waiting', 'settled', 'timed_out'))
  `);
}
