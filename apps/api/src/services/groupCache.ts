// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryGroup } from '../providers/types.js';
import { stringifyForJsonb } from '../lib/jsonbSafe.js';

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
    .where('object_guid', 'not in', Array.from(seenGuids))
    .execute();
}
