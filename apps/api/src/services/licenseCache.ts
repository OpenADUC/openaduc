// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { LicenseSku } from '@openaduc/shared';
import type { DB } from '../db/types.js';
import { licenseSku, type LicensedEntraGroup } from './entraLicenses.js';

// The licensed Entra groups as entra.licenses.groups last read them
// (entra_group_licenses), so a group picker can badge them without asking
// Graph. An AD group is matched by SID when read, so one the AD sync
// caches after the licence task ran still finds its licences.

const rowOf = (providerId: number, g: LicensedEntraGroup) => ({
  provider_id: providerId,
  entra_group_id: g.entraGroupId,
  display_name: g.displayName,
  on_premises_sid: g.onPremisesSid,
  skus: JSON.stringify(g.skus),
  refreshed_at: new Date(),
});

/** Replace the directory's licensed groups with a fresh read of every one. */
export async function replaceLicensedGroups(
  db: Kysely<DB>,
  providerId: number,
  groups: LicensedEntraGroup[],
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('entra_group_licenses').where('provider_id', '=', providerId).execute();
    if (groups.length) {
      await trx
        .insertInto('entra_group_licenses')
        .values(groups.map((g) => rowOf(providerId, g)))
        .execute();
    }
  });
}

/**
 * Keep the cache in step with one group just read live: a group that
 * grants nothing, or isn't in Entra, drops out.
 */
export async function storeLicensedGroup(
  db: Kysely<DB>,
  providerId: number,
  sid: string,
  group: LicensedEntraGroup | null,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('entra_group_licenses')
      .where('provider_id', '=', providerId)
      .where('on_premises_sid', '=', sid)
      .execute();
    if (group?.skus.length) {
      await trx.insertInto('entra_group_licenses').values(rowOf(providerId, group)).execute();
    }
  });
}

/** Every cached AD group that grants a licence, by objectGUID. */
export async function licensedAdGroups(
  db: Kysely<DB>,
  providerId: number,
): Promise<{ id: string; licenses: LicenseSku[] }[]> {
  const rows = await db
    .selectFrom('entra_group_licenses as l')
    .innerJoin('group_cache_records as g', (j) =>
      j.onRef('g.provider_id', '=', 'l.provider_id').onRef('g.sid', '=', 'l.on_premises_sid'),
    )
    .where('l.provider_id', '=', providerId)
    .where('g.deleted_at', 'is', null)
    .select(['g.object_guid', 'l.skus'])
    .execute();
  return rows.map((r) => ({
    id: r.object_guid,
    licenses: r.skus
      .map((s) => licenseSku(s.skuId, s.skuPartNumber))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** The cached AD groups with these SIDs, as objectGUID by SID. */
export async function adGroupsBySid(
  db: Kysely<DB>,
  providerId: number,
  sids: string[],
): Promise<Map<string, string>> {
  if (!sids.length) return new Map();
  const rows = await db
    .selectFrom('group_cache_records')
    .select(['sid', 'object_guid'])
    .where('provider_id', '=', providerId)
    .where('sid', 'in', sids)
    .where('deleted_at', 'is', null)
    .execute();
  return new Map(rows.map((r) => [r.sid!, r.object_guid]));
}
