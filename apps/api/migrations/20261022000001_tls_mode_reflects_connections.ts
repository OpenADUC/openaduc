// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Until now every directory connected with TLS from the first byte,
  // whatever its tls_mode said: ldapts treats any tlsOptions as "use TLS",
  // and the API always passed them. StartTLS is now real and plain is gone,
  // so record what existing directories actually did. Their ldap:// URLs, if
  // any, keep connecting with TLS and show up as needing a fix.
  await knex('directory_providers').whereNot('tls_mode', 'ldaps').update({ tls_mode: 'ldaps' });
}

export async function down(): Promise<void> {
  // The previous modes had no effect on connections; nothing to restore.
}
