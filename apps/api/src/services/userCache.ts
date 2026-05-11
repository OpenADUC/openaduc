// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryUser } from '../providers/types.js';
import { stringifyForJsonb } from '../lib/jsonbSafe.js';

// Helpers for upserting normalized DirectoryUser records into user_cache_records.
// Used by both the live-refresh service (single record) and the sync worker
// (bulk).

function dateOrNull(v: Date | null): string | null {
  return v ? v.toISOString() : null;
}

export interface UpsertUserResult {
  id: number;
  syncedAt: Date;
}

export async function upsertUser(
  db: Kysely<DB>,
  providerId: number,
  user: DirectoryUser,
  options: { source: 'sync' | 'live-refresh' } = { source: 'sync' },
): Promise<UpsertUserResult> {
  const now = new Date();
  const syncedAtIso = now.toISOString();
  const liveRefreshedAtIso = options.source === 'live-refresh' ? syncedAtIso : null;

  const row = await db
    .insertInto('user_cache_records')
    .values({
      provider_id: providerId,
      object_guid: user.objectGuid,
      sid: user.sid,
      distinguished_name: user.distinguishedName,
      sam_account_name: user.samAccountName,
      user_principal_name: user.userPrincipalName,
      display_name: user.displayName,
      given_name: user.givenName,
      surname: user.surname,
      email: user.email,
      phone: user.phone,
      mobile: user.mobile,
      title: user.title,
      department: user.department,
      manager_dn: user.managerDn,
      enabled: user.enabled,
      locked: user.locked,
      password_never_expires: user.passwordNeverExpires,
      password_last_set_at: dateOrNull(user.passwordLastSetAt),
      password_expires_at: dateOrNull(user.passwordExpiresAt),
      account_expires_at: dateOrNull(user.accountExpiresAt),
      last_logon_at: dateOrNull(user.lastLogonAt),
      created_at_source: dateOrNull(user.createdAtSource),
      modified_at_source: dateOrNull(user.modifiedAtSource),
      synced_at: syncedAtIso,
      live_refreshed_at: liveRefreshedAtIso,
      stale_at: null,
      deleted_at: null,
      raw_attributes_json: stringifyForJsonb(user.rawAttributes),
    })
    .onConflict((oc) =>
      oc.columns(['provider_id', 'object_guid']).doUpdateSet((eb) => ({
        sid: eb.ref('excluded.sid'),
        distinguished_name: eb.ref('excluded.distinguished_name'),
        sam_account_name: eb.ref('excluded.sam_account_name'),
        user_principal_name: eb.ref('excluded.user_principal_name'),
        display_name: eb.ref('excluded.display_name'),
        given_name: eb.ref('excluded.given_name'),
        surname: eb.ref('excluded.surname'),
        email: eb.ref('excluded.email'),
        phone: eb.ref('excluded.phone'),
        mobile: eb.ref('excluded.mobile'),
        title: eb.ref('excluded.title'),
        department: eb.ref('excluded.department'),
        manager_dn: eb.ref('excluded.manager_dn'),
        enabled: eb.ref('excluded.enabled'),
        locked: eb.ref('excluded.locked'),
        password_never_expires: eb.ref('excluded.password_never_expires'),
        password_last_set_at: eb.ref('excluded.password_last_set_at'),
        password_expires_at: eb.ref('excluded.password_expires_at'),
        account_expires_at: eb.ref('excluded.account_expires_at'),
        last_logon_at: eb.ref('excluded.last_logon_at'),
        created_at_source: eb.ref('excluded.created_at_source'),
        modified_at_source: eb.ref('excluded.modified_at_source'),
        synced_at: eb.ref('excluded.synced_at'),
        // For live-refresh, replace; for sync runs, leave any existing
        // live_refreshed_at alone so a sync doesn't blank a recent live refresh.
        live_refreshed_at:
          options.source === 'live-refresh'
            ? eb.ref('excluded.live_refreshed_at')
            : eb.ref('user_cache_records.live_refreshed_at'),
        stale_at: sql<null>`null::timestamptz`,
        deleted_at: sql<null>`null::timestamptz`,
        raw_attributes_json: eb.ref('excluded.raw_attributes_json'),
      })),
    )
    .returning(['id', 'synced_at'])
    .executeTakeFirstOrThrow();

  return { id: row.id, syncedAt: new Date(row.synced_at as unknown as string) };
}
