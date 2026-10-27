// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryUser } from '../providers/types.js';
import { stringifyForJsonb } from '../lib/jsonbSafe.js';
import { uuidNotIn } from '../lib/sqlSets.js';

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
      office: user.office ?? null,
      office_read: true,
      enabled: user.enabled,
      locked: user.locked,
      password_never_expires: user.passwordNeverExpires,
      password_last_set_at: dateOrNull(user.passwordLastSetAt),
      password_expires_at: dateOrNull(user.passwordExpiresAt),
      password_must_change: user.passwordMustChange,
      password_expiry_computed: user.passwordExpiryComputed ?? false,
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
        office: eb.ref('excluded.office'),
        office_read: eb.ref('excluded.office_read'),
        enabled: eb.ref('excluded.enabled'),
        locked: eb.ref('excluded.locked'),
        password_never_expires: eb.ref('excluded.password_never_expires'),
        password_last_set_at: eb.ref('excluded.password_last_set_at'),
        password_expires_at: eb.ref('excluded.password_expires_at'),
        password_must_change: eb.ref('excluded.password_must_change'),
        password_expiry_computed: eb.ref('excluded.password_expiry_computed'),
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

/**
 * Drop users that are gone from the directory (deleted, or moved out of the
 * base DN) from list views, with their group memberships, rather than
 * waiting for a sync. A restore or sync upserts the row, which clears
 * deleted_at again.
 */
export async function forgetDeletedUsers(
  db: Kysely<DB>,
  providerId: number,
  objectGuids: readonly string[],
): Promise<void> {
  if (objectGuids.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('user_cache_records')
      .set({ deleted_at: new Date().toISOString() })
      .where('provider_id', '=', providerId)
      .where('object_guid', 'in', objectGuids)
      .where('deleted_at', 'is', null)
      .execute();
    await trx
      .deleteFrom('user_group_memberships')
      .where('provider_id', '=', providerId)
      .where('user_object_guid', 'in', objectGuids)
      .execute();
  });
}

/**
 * Mark cached users the last full crawl didn't see as stale (shown with a
 * staleness badge; deletion is the tombstone sync's job).
 */
export async function markUsersStale(
  db: Kysely<DB>,
  providerId: number,
  seen: Set<string>,
): Promise<void> {
  const now = new Date().toISOString();
  let query = db
    .updateTable('user_cache_records')
    .set({ stale_at: now })
    .where('provider_id', '=', providerId)
    .where('stale_at', 'is', null);
  if (seen.size > 0) query = query.where(uuidNotIn('object_guid', seen));
  await query.execute();
}

/**
 * Clear the locked flag on every cached user of the directory that's
 * marked locked but isn't in `stillLocked` (an admin unlocked them
 * elsewhere, or the lockout ran out). Returns how many were cleared.
 */
export async function clearLockedExcept(
  db: Kysely<DB>,
  providerId: number,
  stillLocked: ReadonlySet<string>,
  now: string,
): Promise<number> {
  let query = db
    .updateTable('user_cache_records')
    .set({ locked: false, live_refreshed_at: now })
    .where('provider_id', '=', providerId)
    .where('locked', '=', true);
  if (stillLocked.size > 0) query = query.where(uuidNotIn('object_guid', stillLocked));
  const res = await query.executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0n);
}

/**
 * A cached object's values of `attribute` as a jsonb array, from the raw
 * attributes column `rawColumn` (AD sends one value as a string, several as
 * an array).
 */
export function rawValuesArray(rawColumn: string, attribute: string): RawBuilder<unknown> {
  const raw = sql.ref(rawColumn);
  return sql`CASE
    WHEN jsonb_typeof(${raw} -> ${attribute}) = 'array' THEN ${raw} -> ${attribute}
    WHEN ${raw} ? ${attribute} THEN jsonb_build_array(${raw} -> ${attribute})
    ELSE '[]'::jsonb
  END`;
}

/** A cached user's memberOf DNs as a jsonb array. */
export function memberOfArray(rawColumn: string): RawBuilder<unknown> {
  return rawValuesArray(rawColumn, 'memberOf');
}

/** GUIDs of cached users whose memberOf lists `groupDn`. */
export async function cachedMembersOf(
  db: Kysely<DB>,
  providerId: number,
  groupDn: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom('user_cache_records')
    .select('object_guid')
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(
      sql<boolean>`exists (
        select 1 from jsonb_array_elements_text(${memberOfArray('raw_attributes_json')}) as member_of
        where lower(member_of) = lower(${groupDn})
      )`,
    )
    .execute();
  return rows.map((r) => r.object_guid);
}

/** A user the cache holds and hasn't seen deleted, by objectGUID or by DN. */
export function findCachedUser(
  db: Kysely<DB>,
  providerId: number,
  by: { id: string } | { dn: string },
) {
  const query = db
    .selectFrom('user_cache_records')
    .select(['object_guid', 'distinguished_name', 'sam_account_name', 'display_name'])
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null);
  return (
    'id' in by
      ? query.where('object_guid', '=', by.id)
      : query.where(sql<string>`lower(distinguished_name)`, '=', by.dn.toLowerCase())
  ).executeTakeFirst();
}

/** How a cached user is named: display name, else logon name, else `fallback`. */
export function cachedUserName(
  user: { display_name: string | null; sam_account_name: string | null },
  fallback: string,
): string {
  return user.display_name ?? user.sam_account_name ?? fallback;
}
