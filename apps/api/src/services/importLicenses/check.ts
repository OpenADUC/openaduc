// SPDX-License-Identifier: BUSL-1.1
// What the final check warns about the licenses an import's groups grant,
// from the license cache (entra_group_licenses): a product with fewer
// seats free than the people joining groups that grant it, and a bucket
// group that's only inside a licensed group, which group-based licensing
// doesn't follow. Warnings only: Entra, not AD, refuses the assignment,
// and only once the people have synced.
import type { ImportCheckIssue } from '@openaduc/shared';
import { sql, type Kysely } from 'kysely';
import type { DB, EntraGroupSku } from '../../db/types.js';
import { skuName } from '../../lib/skuNames.js';
import { subscribedSeats } from '../entraLicenses.js';
import type { GraphReader } from '../entraLookup.js';
import { findCachedGroupsById } from '../groupCache.js';

/** Group nesting is followed this deep, which also ends a loop. */
const MAX_DEPTH = 20;

const lower = (v: string) => v.toLowerCase();
const people = (n: number) => (n === 1 ? '1 person joins' : `${n} people join`);
const names = (list: string[]) =>
  list.length <= 1
    ? (list[0] ?? '')
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]!}`;

export interface LicensedGroup {
  /** The AD group's objectGUID, lower case. */
  id: string;
  name: string;
  entraGroupId: string;
  skus: EntraGroupSku[];
}

/** The groups among these (AD objectGUIDs) that grant licenses, as the cache has them. */
export async function licensedGroupsById(
  db: Kysely<DB>,
  providerId: number,
  ids: readonly string[],
): Promise<Map<string, LicensedGroup>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('entra_group_licenses as l')
    .innerJoin('group_cache_records as g', (j) =>
      j.onRef('g.provider_id', '=', 'l.provider_id').onRef('g.sid', '=', 'l.on_premises_sid'),
    )
    .select(['g.object_guid', 'g.name', 'l.entra_group_id', 'l.skus'])
    .where('l.provider_id', '=', providerId)
    .where('g.deleted_at', 'is', null)
    .where(sql<string>`lower(g.object_guid::text)`, 'in', ids.map(lower))
    .execute();
  return new Map(
    rows
      .filter((r) => r.skus.length > 0)
      .map((r) => [
        lower(r.object_guid),
        {
          id: lower(r.object_guid),
          name: r.name ?? r.object_guid,
          entraGroupId: r.entra_group_id,
          skus: r.skus,
        },
      ]),
  );
}

/**
 * The licensed groups each of these groups is inside, at any depth, and
 * the SKUs they grant, by the inner group's objectGUID.
 */
async function licensedAncestors(
  db: Kysely<DB>,
  providerId: number,
  ids: readonly string[],
): Promise<Map<string, { name: string; skus: EntraGroupSku[] }[]>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<{ start: string; name: string | null; skus: EntraGroupSku[] }>`
    WITH RECURSIVE up (start, parent, depth) AS (
      SELECT member_group_object_guid, group_object_guid, 1
        FROM group_group_memberships
       WHERE provider_id = ${providerId}
         AND lower(member_group_object_guid::text) = ANY(${ids.map(lower)}::text[])
      UNION
      SELECT up.start, m.group_object_guid, up.depth + 1
        FROM up
        JOIN group_group_memberships m
          ON m.provider_id = ${providerId} AND m.member_group_object_guid = up.parent
       WHERE up.depth < ${MAX_DEPTH}
    )
    SELECT DISTINCT lower(up.start::text) AS start, p.name, l.skus
      FROM up
      JOIN group_cache_records p
        ON p.provider_id = ${providerId} AND p.object_guid = up.parent AND p.deleted_at IS NULL
      JOIN entra_group_licenses l
        ON l.provider_id = ${providerId} AND l.on_premises_sid = p.sid
  `.execute(db);
  const out = new Map<string, { name: string; skus: EntraGroupSku[] }[]>();
  for (const r of rows) {
    if (r.skus.length === 0) continue;
    out.set(r.start, [...(out.get(r.start) ?? []), { name: r.name ?? 'a group', skus: r.skus }]);
  }
  return out;
}

export interface LicenseCheckDeps {
  db: Kysely<DB>;
  providerId: number;
  graph: GraphReader;
}

/**
 * The final check's license warnings for rows joining these groups (by
 * objectGUID). Every row is a new account, so each one a product's groups
 * take in is a seat more; one in two groups granting it is counted once.
 * Seats other assignments still being processed will take aren't known.
 */
export async function licenseWarnings(
  deps: LicenseCheckDeps,
  rows: readonly { groups?: readonly string[] | undefined }[],
): Promise<ImportCheckIssue[]> {
  const { db, providerId } = deps;
  const warn = (message: string, kind: ImportCheckIssue['kind']): ImportCheckIssue => ({
    row: null,
    kind,
    message,
  });
  const groupIds = [...new Set(rows.flatMap((r) => (r.groups ?? []).map(lower)))];
  if (groupIds.length === 0) return [];
  const licensed = await licensedGroupsById(db, providerId, groupIds);
  const warnings: ImportCheckIssue[] = [];

  // Products and how many rows each one goes to.
  const wanted = new Map<string, { sku: EntraGroupSku; people: number }>();
  for (const r of rows) {
    const skus = new Map<string, EntraGroupSku>();
    for (const id of r.groups ?? []) {
      for (const sku of licensed.get(lower(id))?.skus ?? []) skus.set(lower(sku.skuId), sku);
    }
    for (const [key, sku] of skus) {
      const entry = wanted.get(key) ?? { sku, people: 0 };
      entry.people++;
      wanted.set(key, entry);
    }
  }
  if (wanted.size > 0) {
    try {
      const seats = await subscribedSeats(deps.graph);
      for (const [key, { sku, people: n }] of wanted) {
        const held = seats.get(key);
        const name = skuName(sku.skuId, held?.skuPartNumber ?? sku.skuPartNumber);
        const free = Math.max(0, (held?.enabled ?? 0) - (held?.consumed ?? 0));
        if (n <= free) continue;
        const grace = held?.warning
          ? ` Another ${held.warning} are in a lapsed subscription’s grace period, so they don’t last.`
          : '';
        const what = held
          ? free === 0
            ? 'none is free'
            : `only ${free} ${free === 1 ? 'is' : 'are'} free`
          : 'the tenant has no subscription to it';
        warnings.push(
          warn(
            `${name}: ${people(n)} groups that grant it, but ${what}. Entra won’t assign it to ${n - free} of them until licenses are bought or freed up.${grace}`,
            'license_seats',
          ),
        );
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      warnings.push(warn(`Couldn’t check the free licenses in Entra: ${why}`, 'license_seats'));
    }
  }

  const ancestors = await licensedAncestors(db, providerId, groupIds);
  const inner = await findCachedGroupsById(db, providerId, [...ancestors.keys()]);
  for (const id of groupIds) {
    const outer = ancestors.get(id);
    if (!outer) continue;
    const own = new Set((licensed.get(id)?.skus ?? []).map((s) => lower(s.skuId)));
    const missed = new Map<string, string>();
    const via = new Set<string>();
    for (const g of outer) {
      for (const s of g.skus) {
        if (own.has(lower(s.skuId))) continue;
        missed.set(lower(s.skuId), skuName(s.skuId, s.skuPartNumber));
        via.add(g.name);
      }
    }
    if (missed.size === 0) continue;
    const name = inner.get(id)?.name ?? id;
    const outerNames = [...via].map((n) => `“${n}”`);
    warnings.push(
      warn(
        `“${name}” is inside ${names(outerNames)}, which ${via.size === 1 ? 'grants' : 'grant'} ${names([...missed.values()])}, but group-based licensing doesn’t follow nested groups: the people added to ${name} don’t get ${missed.size === 1 ? 'it' : 'them'}. License ${name} itself, or add them to ${names(outerNames)} too.`,
        'license_nested',
      ),
    );
  }
  return warnings;
}
