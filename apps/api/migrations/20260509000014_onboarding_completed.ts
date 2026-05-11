// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Track when the operator finished the first-run wizard. Distinct from
// `directory_providers.configured` (which flips after step 1) because
// the wizard has additional steps — service account, password policy,
// initial sync — and the router only stops forcing /setup once the
// whole flow has completed.
//
// Stored as ISO timestamp string (or null) in app_settings so it lives
// alongside other operator-tunable settings and follows the same
// audit/cache machinery.

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `INSERT INTO app_settings (key, value_json, description) VALUES
     ('onboarding.completed_at', NULL,
      'Timestamp when the first-run setup wizard completed. Null = wizard still in progress; the router forces /setup until this is set.')
     ON CONFLICT (key) DO NOTHING`,
  );

  // Backfill: any existing instance with at least one configured directory
  // predates this wizard; mark onboarding done so the router doesn't kick
  // upgraded instances back into a multi-step flow they've already passed.
  await knex.raw(
    `UPDATE app_settings
       SET value_json = to_jsonb(now()::text)
     WHERE key = 'onboarding.completed_at'
       AND value_json IS NULL
       AND EXISTS (SELECT 1 FROM directory_providers WHERE configured = true)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DELETE FROM app_settings WHERE key = 'onboarding.completed_at'`);
}
