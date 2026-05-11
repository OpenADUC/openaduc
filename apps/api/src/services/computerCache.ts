// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryComputer } from '../providers/types.js';
import { stringifyForJsonb } from '../lib/jsonbSafe.js';

/**
 * Upsert a computer into the cache. Mirrors the user / group cache helpers.
 * Used by both delta and full sync runners.
 */
export async function upsertComputer(
  db: Kysely<DB>,
  providerId: number,
  computer: DirectoryComputer,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('computer_cache_records')
    .values({
      provider_id: providerId,
      object_guid: computer.objectGuid,
      sid: computer.sid,
      distinguished_name: computer.distinguishedName,
      sam_account_name: computer.samAccountName,
      name: computer.name,
      dns_host_name: computer.dnsHostName,
      operating_system: computer.operatingSystem,
      operating_system_version: computer.operatingSystemVersion,
      description: computer.description,
      managed_by_dn: computer.managedByDn,
      enabled: computer.enabled,
      last_logon_at: computer.lastLogonAt ? computer.lastLogonAt.toISOString() : null,
      password_last_set_at: computer.passwordLastSetAt
        ? computer.passwordLastSetAt.toISOString()
        : null,
      created_at_source: computer.createdAtSource ? computer.createdAtSource.toISOString() : null,
      modified_at_source: computer.modifiedAtSource
        ? computer.modifiedAtSource.toISOString()
        : null,
      synced_at: now,
      stale_at: null,
      deleted_at: null,
      raw_attributes_json: stringifyForJsonb(computer.rawAttributes),
    })
    .onConflict((oc) =>
      oc.columns(['provider_id', 'object_guid']).doUpdateSet((eb) => ({
        sid: eb.ref('excluded.sid'),
        distinguished_name: eb.ref('excluded.distinguished_name'),
        sam_account_name: eb.ref('excluded.sam_account_name'),
        name: eb.ref('excluded.name'),
        dns_host_name: eb.ref('excluded.dns_host_name'),
        operating_system: eb.ref('excluded.operating_system'),
        operating_system_version: eb.ref('excluded.operating_system_version'),
        description: eb.ref('excluded.description'),
        managed_by_dn: eb.ref('excluded.managed_by_dn'),
        enabled: eb.ref('excluded.enabled'),
        last_logon_at: eb.ref('excluded.last_logon_at'),
        password_last_set_at: eb.ref('excluded.password_last_set_at'),
        created_at_source: eb.ref('excluded.created_at_source'),
        modified_at_source: eb.ref('excluded.modified_at_source'),
        synced_at: eb.ref('excluded.synced_at'),
        stale_at: sql<null>`null::timestamptz`,
        deleted_at: sql<null>`null::timestamptz`,
        raw_attributes_json: eb.ref('excluded.raw_attributes_json'),
      })),
    )
    .execute();
}

/**
 * Mark computers absent from the latest full crawl as stale. Cache reads
 * surface staleness with a badge; deletes are handled by tombstone polling.
 */
export async function markComputersStale(
  db: Kysely<DB>,
  providerId: number,
  seenGuids: Set<string>,
): Promise<void> {
  const now = new Date().toISOString();
  if (seenGuids.size === 0) {
    await db
      .updateTable('computer_cache_records')
      .set({ stale_at: now })
      .where('provider_id', '=', providerId)
      .where('stale_at', 'is', null)
      .execute();
    return;
  }
  await db
    .updateTable('computer_cache_records')
    .set({ stale_at: now })
    .where('provider_id', '=', providerId)
    .where('stale_at', 'is', null)
    .where('object_guid', 'not in', Array.from(seenGuids))
    .execute();
}
