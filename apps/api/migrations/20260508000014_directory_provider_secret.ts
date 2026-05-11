// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // The bind credential for the service account, encrypted at rest with
  // AES-256-GCM under the ENCRYPTION_KEY env var. Stored as a self-contained
  // text envelope: "v1.<iv-b64>.<ciphertext-b64>.<tag-b64>".
  await knex.schema.alterTable('directory_providers', (t) => {
    t.text('bind_secret_encrypted');
    t.text('display_name');
    // Marks providers created via the setup wizard so we never auto-recreate
    // them from env at boot once an operator has configured one.
    t.boolean('configured').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('directory_providers', (t) => {
    t.dropColumn('bind_secret_encrypted');
    t.dropColumn('display_name');
    t.dropColumn('configured');
  });
}
