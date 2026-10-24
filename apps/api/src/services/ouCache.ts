// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryOu } from '../providers/types.js';
import { stringifyForJsonb } from '../lib/jsonbSafe.js';
import { memberOfArray, rawValuesArray } from './userCache.js';

/**
 * Upsert an OU into the cache. The unique key is
 * (provider_id, lower(distinguished_name)) so we use raw SQL for the
 * conflict target — Kysely's `onConflict.columns` can't reference a
 * functional index.
 */
export async function upsertOu(db: Kysely<DB>, providerId: number, ou: DirectoryOu): Promise<void> {
  const now = new Date().toISOString();
  const raw = stringifyForJsonb(ou.rawAttributes);
  await sql`
    INSERT INTO directory_ous
      (provider_id, distinguished_name, name, parent_dn, synced_at, stale_at, deleted_at, raw_attributes_json)
    VALUES
      (${providerId}, ${ou.distinguishedName}, ${ou.name}, ${ou.parentDn}, ${now}, NULL, NULL, ${raw}::jsonb)
    ON CONFLICT (provider_id, lower(distinguished_name)) DO UPDATE SET
      distinguished_name = EXCLUDED.distinguished_name,
      name = EXCLUDED.name,
      parent_dn = EXCLUDED.parent_dn,
      synced_at = EXCLUDED.synced_at,
      stale_at = NULL,
      deleted_at = NULL,
      raw_attributes_json = EXCLUDED.raw_attributes_json
  `.execute(db);
}

export async function markOusStale(
  db: Kysely<DB>,
  providerId: number,
  seenDnsLower: Set<string>,
): Promise<void> {
  const now = new Date().toISOString();
  if (seenDnsLower.size === 0) {
    await db
      .updateTable('directory_ous')
      .set({ stale_at: now })
      .where('provider_id', '=', providerId)
      .where('stale_at', 'is', null)
      .execute();
    return;
  }
  await sql`
    UPDATE directory_ous
    SET stale_at = ${now}
    WHERE provider_id = ${providerId}
      AND stale_at IS NULL
      AND lower(distinguished_name) <> ALL(${Array.from(seenDnsLower)}::text[])
  `.execute(db);
}

/**
 * Wipe and rebuild the membership join tables: user_group_memberships from
 * `memberOf` arrays in user cache rows, group_group_memberships from
 * `member` arrays in group cache rows. Volumes here are small enough (low
 * tens of thousands) that this is simpler than incremental patching and
 * always correct.
 */
export async function rebuildMemberships(
  db: Kysely<DB>,
  providerId: number,
): Promise<{ count: number }> {
  // One transaction: readers see the old memberships or the new ones,
  // never an empty table between the delete and the insert.
  return db.transaction().execute(async (trx) => {
    await trx.deleteFrom('user_group_memberships').where('provider_id', '=', providerId).execute();
    await trx.deleteFrom('group_group_memberships').where('provider_id', '=', providerId).execute();
    const users = await sql<{ count: string }>`
    WITH inserted AS (
      INSERT INTO user_group_memberships (provider_id, user_object_guid, group_object_guid, direct, synced_at)
      SELECT
        u.provider_id,
        u.object_guid,
        g.object_guid,
        true,
        now()
      FROM user_cache_records u
      CROSS JOIN LATERAL jsonb_array_elements_text(${memberOfArray('u.raw_attributes_json')}) AS member_dn
      JOIN group_cache_records g
        ON g.provider_id = u.provider_id
        AND lower(g.distinguished_name) = lower(member_dn)
      WHERE u.provider_id = ${providerId}
        AND u.deleted_at IS NULL
        AND g.deleted_at IS NULL
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT COUNT(*)::text AS count FROM inserted
  `.execute(trx);
    const groups = await sql<{ count: string }>`
    WITH inserted AS (
      INSERT INTO group_group_memberships (provider_id, group_object_guid, member_group_object_guid, synced_at)
      SELECT g.provider_id, g.object_guid, m.object_guid, now()
      FROM group_cache_records g
      CROSS JOIN LATERAL jsonb_array_elements_text(${rawValuesArray('g.raw_attributes_json', 'member')}) AS member_dn
      JOIN group_cache_records m
        ON m.provider_id = g.provider_id
        AND lower(m.distinguished_name) = lower(member_dn)
      WHERE g.provider_id = ${providerId}
        AND g.deleted_at IS NULL
        AND m.deleted_at IS NULL
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT COUNT(*)::text AS count FROM inserted
  `.execute(trx);
    return { count: Number(users.rows[0]?.count ?? 0) + Number(groups.rows[0]?.count ?? 0) };
  });
}

export interface CachedOu {
  distinguished_name: string;
  name: string;
}

/**
 * A live OU from the cache, matched case-insensitively, with its DN as AD
 * spells it; null when OpenADUC doesn't know it. Routes use this to refuse
 * an OU the sync hasn't seen before asking AD.
 */
export async function findCachedOu(
  db: Kysely<DB>,
  providerId: number,
  dn: string,
): Promise<CachedOu | null> {
  const row = await db
    .selectFrom('directory_ous')
    .select(['distinguished_name', 'name'])
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<string>`lower(distinguished_name)`, '=', dn.toLowerCase())
    .executeTakeFirst();
  return row ?? null;
}
