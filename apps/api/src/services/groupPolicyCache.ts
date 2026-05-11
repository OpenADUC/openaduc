// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryGroupPolicy, DirectoryGroupPolicyLink } from '../providers/types.js';
import { stringifyForJsonb } from '../lib/jsonbSafe.js';

/**
 * Upsert a Group Policy Object into the cache. Conflict target is
 * (provider_id, object_guid) — same shape as the user/group/computer caches.
 */
export async function upsertGroupPolicy(
  db: Kysely<DB>,
  providerId: number,
  gpo: DirectoryGroupPolicy,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('directory_group_policies')
    .values({
      provider_id: providerId,
      object_guid: gpo.objectGuid,
      gpo_guid: gpo.gpoGuid,
      distinguished_name: gpo.distinguishedName,
      display_name: gpo.displayName,
      file_sys_path: gpo.fileSysPath,
      functionality_version: gpo.functionalityVersion,
      version_number_raw: gpo.versionNumberRaw,
      user_version: gpo.userVersion,
      computer_version: gpo.computerVersion,
      flags_raw: gpo.flagsRaw,
      user_policy_enabled: gpo.userPolicyEnabled,
      computer_policy_enabled: gpo.computerPolicyEnabled,
      wmi_filter_ref: gpo.wmiFilterRef,
      computer_extension_guids: stringifyForJsonb(gpo.computerExtensionGuids) as never,
      user_extension_guids: stringifyForJsonb(gpo.userExtensionGuids) as never,
      created_at_source: gpo.createdAtSource ?? null,
      modified_at_source: gpo.modifiedAtSource ?? null,
      synced_at: now,
      stale_at: null,
      deleted_at: null,
      raw_attributes_json: stringifyForJsonb(gpo.rawAttributes) as never,
    })
    .onConflict((oc) =>
      oc.columns(['provider_id', 'object_guid']).doUpdateSet({
        gpo_guid: (eb) => eb.ref('excluded.gpo_guid'),
        distinguished_name: (eb) => eb.ref('excluded.distinguished_name'),
        display_name: (eb) => eb.ref('excluded.display_name'),
        file_sys_path: (eb) => eb.ref('excluded.file_sys_path'),
        functionality_version: (eb) => eb.ref('excluded.functionality_version'),
        version_number_raw: (eb) => eb.ref('excluded.version_number_raw'),
        user_version: (eb) => eb.ref('excluded.user_version'),
        computer_version: (eb) => eb.ref('excluded.computer_version'),
        flags_raw: (eb) => eb.ref('excluded.flags_raw'),
        user_policy_enabled: (eb) => eb.ref('excluded.user_policy_enabled'),
        computer_policy_enabled: (eb) => eb.ref('excluded.computer_policy_enabled'),
        wmi_filter_ref: (eb) => eb.ref('excluded.wmi_filter_ref'),
        computer_extension_guids: (eb) => eb.ref('excluded.computer_extension_guids'),
        user_extension_guids: (eb) => eb.ref('excluded.user_extension_guids'),
        created_at_source: (eb) => eb.ref('excluded.created_at_source'),
        modified_at_source: (eb) => eb.ref('excluded.modified_at_source'),
        synced_at: (eb) => eb.ref('excluded.synced_at'),
        stale_at: null,
        deleted_at: null,
        raw_attributes_json: (eb) => eb.ref('excluded.raw_attributes_json'),
      }),
    )
    .execute();
}

export async function markGroupPoliciesStale(
  db: Kysely<DB>,
  providerId: number,
  seenGuids: Set<string>,
): Promise<void> {
  const now = new Date().toISOString();
  if (seenGuids.size === 0) {
    await db
      .updateTable('directory_group_policies')
      .set({ stale_at: now })
      .where('provider_id', '=', providerId)
      .where('stale_at', 'is', null)
      .execute();
    return;
  }
  // object_guid is uuid; compare uuid-to-uuid directly. Postgres canonicalizes
  // uuids to lowercase on storage, so a Set of textual GUIDs from the provider
  // matches without any case-folding.
  await db
    .updateTable('directory_group_policies')
    .set({ stale_at: now })
    .where('provider_id', '=', providerId)
    .where('stale_at', 'is', null)
    .where('object_guid', 'not in', Array.from(seenGuids))
    .execute();
}

/**
 * Replace the gPLink rows for a provider in one shot. Links are tiny and
 * always derived from the same scan — incremental patching would be more
 * code than benefit.
 */
export async function replaceGroupPolicyLinks(
  db: Kysely<DB>,
  providerId: number,
  links: DirectoryGroupPolicyLink[],
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom('directory_group_policy_links')
      .where('provider_id', '=', providerId)
      .execute();
    if (links.length === 0) return;
    const now = new Date().toISOString();
    await tx
      .insertInto('directory_group_policy_links')
      .values(
        links.map((l) => ({
          provider_id: providerId,
          scope_dn: l.scopeDn,
          gpo_dn: l.gpoDn,
          gpo_guid: l.gpoGuid,
          link_order: l.order,
          flags_raw: l.flagsRaw,
          enabled: l.enabled,
          enforced: l.enforced,
          synced_at: now,
        })),
      )
      .execute();
  });
}
