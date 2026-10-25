// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryGroup } from '../providers/types.js';
import { stringifyForJsonb } from '../lib/jsonbSafe.js';
import { uuidNotIn } from '../lib/sqlSets.js';
import { leafRdnValue } from '../providers/active-directory/normalize.js';
import { rawValuesArray } from './userCache.js';

/**
 * Upsert a group into the cache. Mirrors the user-cache helper. Used by
 * both delta and full sync runners.
 */
export async function upsertGroup(
  db: Kysely<DB>,
  providerId: number,
  group: DirectoryGroup,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('group_cache_records')
    .values({
      provider_id: providerId,
      object_guid: group.objectGuid,
      sid: group.sid,
      distinguished_name: group.distinguishedName,
      sam_account_name: group.samAccountName,
      name: group.name,
      description: group.description,
      group_type: group.groupType,
      group_scope: group.groupScope,
      synced_at: now,
      stale_at: null,
      deleted_at: null,
      raw_attributes_json: stringifyForJsonb(group.rawAttributes),
    })
    .onConflict((oc) =>
      oc.columns(['provider_id', 'object_guid']).doUpdateSet((eb) => ({
        sid: eb.ref('excluded.sid'),
        distinguished_name: eb.ref('excluded.distinguished_name'),
        sam_account_name: eb.ref('excluded.sam_account_name'),
        name: eb.ref('excluded.name'),
        description: eb.ref('excluded.description'),
        group_type: eb.ref('excluded.group_type'),
        group_scope: eb.ref('excluded.group_scope'),
        synced_at: eb.ref('excluded.synced_at'),
        stale_at: sql<null>`null::timestamptz`,
        deleted_at: sql<null>`null::timestamptz`,
        raw_attributes_json: eb.ref('excluded.raw_attributes_json'),
      })),
    )
    .execute();
}

/**
 * Mark groups absent from the latest full crawl as stale. Cache reads
 * surface staleness with a badge; deletes are handled separately.
 */
export async function markGroupsStale(
  db: Kysely<DB>,
  providerId: number,
  seenGuids: Set<string>,
): Promise<void> {
  const now = new Date().toISOString();
  if (seenGuids.size === 0) {
    await db
      .updateTable('group_cache_records')
      .set({ stale_at: now })
      .where('provider_id', '=', providerId)
      .where('stale_at', 'is', null)
      .execute();
    return;
  }
  await db
    .updateTable('group_cache_records')
    .set({ stale_at: now })
    .where('provider_id', '=', providerId)
    .where('stale_at', 'is', null)
    .where(uuidNotIn('object_guid', seenGuids))
    .execute();
}

/**
 * Replace a group's rows in group_group_memberships with the cached groups
 * among `memberDns`, its current `member` values in AD. Called after a write
 * so the group's members show the change before the next rebuild.
 */
export async function reconcileNestedGroups(
  db: Kysely<DB>,
  providerId: number,
  groupObjectGuid: string,
  memberDns: readonly string[],
): Promise<void> {
  const dnsLower = memberDns.map((d) => d.toLowerCase());
  const nested =
    dnsLower.length === 0
      ? []
      : await db
          .selectFrom('group_cache_records')
          .select('object_guid')
          .where('provider_id', '=', providerId)
          .where('deleted_at', 'is', null)
          .where(sql<string>`lower(distinguished_name)`, 'in', dnsLower)
          .execute();

  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('group_group_memberships')
      .where('provider_id', '=', providerId)
      .where('group_object_guid', '=', groupObjectGuid)
      .execute();
    if (nested.length === 0) return;
    await trx
      .insertInto('group_group_memberships')
      .values(
        nested.map((g) => ({
          provider_id: providerId,
          group_object_guid: groupObjectGuid,
          member_group_object_guid: g.object_guid,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  });
}

/**
 * Drop a group just deleted in AD from list views, with its members and its
 * own memberships, rather than waiting for the next sync. Its DN also goes
 * from cached objects' raw memberOf (and parent groups' member), which
 * membership rebuilds read. A restore or sync upserts the row, which
 * clears deleted_at again.
 */
export async function forgetDeletedGroup(
  db: Kysely<DB>,
  providerId: number,
  group: { objectGuid: string; distinguishedName: string },
): Promise<void> {
  const objectGuid = group.objectGuid;
  await db.transaction().execute(async (trx) => {
    for (const [table, attribute] of [
      ['user_cache_records', 'memberOf'],
      ['computer_cache_records', 'memberOf'],
      ['group_cache_records', 'memberOf'],
      ['group_cache_records', 'member'],
    ] as const) {
      await dropRawValue(trx, table, attribute, providerId, group.distinguishedName);
    }
    await trx
      .updateTable('group_cache_records')
      .set({ deleted_at: new Date().toISOString() })
      .where('provider_id', '=', providerId)
      .where('object_guid', '=', objectGuid)
      .execute();
    await trx
      .deleteFrom('user_group_memberships')
      .where('provider_id', '=', providerId)
      .where('group_object_guid', '=', objectGuid)
      .execute();
    await trx
      .deleteFrom('group_group_memberships')
      .where('provider_id', '=', providerId)
      .where((eb) =>
        eb.or([
          eb('group_object_guid', '=', objectGuid),
          eb('member_group_object_guid', '=', objectGuid),
        ]),
      )
      .execute();
  });
}

/** Remove `dn` (case-insensitively) from every cached row's raw `attribute`. */
async function dropRawValue(
  db: Kysely<DB>,
  table: 'user_cache_records' | 'computer_cache_records' | 'group_cache_records',
  attribute: string,
  providerId: number,
  dn: string,
): Promise<void> {
  const values = rawValuesArray('raw_attributes_json', attribute);
  await sql`
    UPDATE ${sql.table(table)}
    SET raw_attributes_json = jsonb_set(
      raw_attributes_json,
      ARRAY[${attribute}]::text[],
      (SELECT coalesce(jsonb_agg(v), '[]'::jsonb)
         FROM jsonb_array_elements(${values}) AS v
        WHERE lower(v #>> '{}') <> lower(${dn}))
    )
    WHERE provider_id = ${providerId}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${values}) AS e WHERE lower(e) = lower(${dn})
      )
  `.execute(db);
}

export interface CachedGroup {
  id: string;
  distinguishedName: string;
  /** The group's name, else its RDN value. */
  name: string;
  sid: string | null;
  rawAttributes: Record<string, unknown>;
}

/** The cached groups with these objectGUIDs, keyed by lower-cased id. */
export async function findCachedGroupsById(
  db: Kysely<DB>,
  providerId: number,
  ids: readonly string[],
): Promise<Map<string, CachedGroup>> {
  const groups = await findCachedGroups(db, providerId, { ids });
  return new Map(groups.map((g) => [g.id.toLowerCase(), g]));
}

/** Groups the cache holds and hasn't seen deleted, by objectGUID or by DN. */
export async function findCachedGroups(
  db: Kysely<DB>,
  providerId: number,
  by: { ids: readonly string[] } | { dns: readonly string[] },
): Promise<CachedGroup[]> {
  const keys = 'ids' in by ? by.ids : by.dns.map((dn) => dn.toLowerCase());
  if (keys.length === 0) return [];
  let query = db
    .selectFrom('group_cache_records')
    .select(['object_guid', 'name', 'distinguished_name', 'sid', 'raw_attributes_json'])
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null);
  query =
    'ids' in by
      ? query.where('object_guid', 'in', [...keys])
      : query.where(sql<string>`lower(distinguished_name)`, 'in', [...keys]);
  const rows = await query.execute();
  return rows.map((r) => ({
    id: r.object_guid,
    distinguishedName: r.distinguished_name,
    name: r.name ?? leafRdnValue(r.distinguished_name) ?? r.distinguished_name,
    sid: r.sid,
    rawAttributes: r.raw_attributes_json,
  }));
}
