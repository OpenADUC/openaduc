// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// MFA registration state for each Entra user, sourced from
// /reports/authenticationMethods/userRegistrationDetails. Storing on the
// existing user_entra_enrichment row keeps the per-user enrichment all
// in one place — the same row that holds sign-in activity timestamps —
// rather than fanning out into a separate table for every Graph report.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_entra_enrichment', (t) => {
    t.boolean('is_mfa_registered'); // null = unknown, never fetched
    t.boolean('is_mfa_capable');
    t.boolean('is_passwordless_capable');
    /**
     * Array of method types from Graph (e.g. 'mobilePhone',
     * 'microsoftAuthenticatorPush', 'fido2', 'softwareOneTimePasscode',
     * 'windowsHelloForBusiness'). Stored as jsonb so adding a method
     * type doesn't need a migration; the runner persists whatever
     * Graph returns.
     */
    t.jsonb('mfa_methods_json');
    t.text('default_mfa_method');
    /** Last time we successfully refreshed MFA fields. Distinct from
     *  fetched_at (sign-in activity) so a slow/failing report endpoint
     *  doesn't poison the staler-of-the-two display. */
    t.timestamp('mfa_fetched_at', { useTz: true });
    /** 'success' | 'forbidden' | 'not_found' | 'p1_required'. */
    t.text('mfa_last_status');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_entra_enrichment', (t) => {
    t.dropColumn('is_mfa_registered');
    t.dropColumn('is_mfa_capable');
    t.dropColumn('is_passwordless_capable');
    t.dropColumn('mfa_methods_json');
    t.dropColumn('default_mfa_method');
    t.dropColumn('mfa_fetched_at');
    t.dropColumn('mfa_last_status');
  });
}
