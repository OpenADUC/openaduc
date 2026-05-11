// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryOu } from '../providers/types.js';
import { stringifyForJsonb } from '../lib/jsonbSafe.js';

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
      AND lower(distinguished_name) NOT IN (${sql.join(Array.from(seenDnsLower))})
  `.execute(db);
}

/**
 * Wipe and rebuild the user_group_memberships join table from
 * `memberOf` arrays in user cache rows. Volumes here are small enough
 * (low tens of thousands) that this is simpler than incremental
 * patching and always correct.
 */
export async function rebuildMemberships(
  db: Kysely<DB>,
  providerId: number,
): Promise<{ count: number }> {
  await db.deleteFrom('user_group_memberships').where('provider_id', '=', providerId).execute();
  const result = await sql<{ count: string }>`
    WITH inserted AS (
      INSERT INTO user_group_memberships (provider_id, user_object_guid, group_object_guid, direct, synced_at)
      SELECT
        u.provider_id,
        u.object_guid,
        g.object_guid,
        true,
        now()
      FROM user_cache_records u
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(u.raw_attributes_json -> 'memberOf') = 'array'
            THEN u.raw_attributes_json -> 'memberOf'
          WHEN u.raw_attributes_json ? 'memberOf'
            THEN jsonb_build_array(u.raw_attributes_json -> 'memberOf')
          ELSE '[]'::jsonb
        END
      ) AS member_dn
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
  `.execute(db);
  const row = result.rows[0];
  return { count: row ? Number(row.count) : 0 };
}
