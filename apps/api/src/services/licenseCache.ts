// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from 'kysely';
import type { LicenseSku } from '@openaduc/shared';
import type { DB } from '../db/types.js';
import { byName, licenseSku } from '../lib/skuNames.js';
import type { LicensedEntraGroup } from './entraLicenses.js';

// The licensed Entra groups as entra.licenses.groups last read them
// (entra_group_licenses), so a group picker can badge them without asking
// Graph. An AD group is matched by SID when read, so one the AD sync
// caches after the license task ran still finds its licenses.

const TASK_KEY = 'entra.licenses.groups';
// Five values a row; Postgres takes at most 65,535 parameters a statement.
const INSERT_CHUNK = 1000;

const rowOf = (providerId: number, g: LicensedEntraGroup) => ({
  provider_id: providerId,
  entra_group_id: g.entraGroupId,
  display_name: g.displayName,
  on_premises_sid: g.onPremisesSid,
  skus: JSON.stringify(g.skus),
});

/** Replace the directory's licensed groups with a fresh read of every one. */
export async function replaceLicensedGroups(
  db: Kysely<DB>,
  providerId: number,
  groups: LicensedEntraGroup[],
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('entra_group_licenses').where('provider_id', '=', providerId).execute();
    for (let i = 0; i < groups.length; i += INSERT_CHUNK) {
      await trx
        .insertInto('entra_group_licenses')
        .values(groups.slice(i, i + INSERT_CHUNK).map((g) => rowOf(providerId, g)))
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

/** Every cached AD group that grants a license, by objectGUID. */
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
    licenses: r.skus.map((s) => licenseSku(s.skuId, s.skuPartNumber)).sort(byName),
  }));
}

/**
 * When the task last read every licensed group, from its run history (a
 * run that skipped, the feature being off, read nothing), and whether its
 * latest run failed.
 */
export async function licensedGroupsRefresh(
  db: Kysely<DB>,
  providerId: number,
): Promise<{ refreshedAt: Date | null; failed: boolean }> {
  const [run, task] = await Promise.all([
    db
      .selectFrom('directory_sync_task_runs')
      .select((eb) => eb.fn.max('finished_at').as('finished_at'))
      .where('provider_id', '=', providerId)
      .where('task_key', '=', TASK_KEY)
      .where('status', '=', 'succeeded')
      .where(sql<boolean>`coalesce(stats_json ->> 'skipped', '') = ''`)
      .executeTakeFirst(),
    db
      .selectFrom('directory_sync_tasks')
      .select(['last_status'])
      .where('provider_id', '=', providerId)
      .where('task_key', '=', TASK_KEY)
      .executeTakeFirst(),
  ]);
  return {
    refreshedAt: run?.finished_at ? new Date(run.finished_at) : null,
    failed: task?.last_status === 'failed',
  };
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
