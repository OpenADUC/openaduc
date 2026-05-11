// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Per-directory Microsoft Entra (Graph) integration. Sibling to the AD
// configuration on directory_providers — each AD directory may optionally
// link a single Entra tenant for enrichment + outbound notifications.
//
// Secrets (client_secret, teams_webhook_url) are AES-256-GCM enveloped via
// the same lib/encryption.ts that handles sync_bind_secret_encrypted.
//
// `features_json` is the per-feature opt-in switchboard — each feature can
// be enabled independently and the runner gates itself on the flag so a
// tenant with limited Graph permissions doesn't fail every task.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('directory_entra_integrations', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    // Entra tenant GUID (e.g. 11111111-2222-3333-4444-555555555555).
    t.uuid('tenant_id').notNullable();
    // App registration's client/application ID (also a GUID in practice but
    // typed as text for forward-compat with non-GUID identifiers).
    t.text('client_id').notNullable();
    // AES-256-GCM envelope; null when secret has been cleared but row kept.
    t.text('client_secret_encrypted');
    // Master switch — false suspends every feature without losing config.
    t.boolean('enabled').notNullable().defaultTo(true);
    // Per-feature opt-ins. Shape: { photos: bool, signInActivity: bool,
    //   teamsAdminWebhook: bool, passwordExpiryNotifications: bool }.
    // Missing keys are treated as false at read time.
    t.jsonb('features_json').notNullable().defaultTo('{}');
    // Incoming webhook URL for the admin Teams channel. Encrypted because
    // the URL itself is the auth (shared secret).
    t.text('teams_webhook_url_encrypted');
    // Self-test telemetry. Populated by POST /api/directories/:id/entra/test
    // and by failure paths in the graph client; surfaces on the settings UI.
    t.timestamp('last_test_at', { useTz: true });
    t.text('last_test_status'); // 'success' | 'failure'
    t.text('last_test_error');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // 1:1 between directory and Entra integration.
    t.unique(['provider_id'], { indexName: 'directory_entra_integrations_provider_id_unique' });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('directory_entra_integrations');
}
