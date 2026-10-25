// SPDX-License-Identifier: BUSL-1.1
// What the final check warns about the licenses an import's groups grant,
// from the license cache (entra_group_licenses): a product with fewer
// seats free than the people joining groups that grant it, and people
// who'd only get a product through a group nested in a licensed one,
// which group-based licensing doesn't follow. Warnings only: Entra, not
// AD, refuses the assignment, and only once the people have synced.
import { andList, type ImportCheckIssue } from '@openaduc/shared';
import { sql, type Kysely } from 'kysely';
import type { DB, EntraGroupSku } from '../../db/types.js';
import { skuName } from '../../lib/skuNames.js';
import { subscribedSeats, type SkuSeats } from '../entraLicenses.js';
import type { GraphReader } from '../entraLookup.js';
import { findCachedGroupsById } from '../groupCache.js';
import { lower } from './rules.js';

/** Group nesting is followed this deep, which also ends a loop. */
const MAX_DEPTH = 20;

const quoted = (names: Iterable<string>) => andList([...names].map((n) => `“${n}”`));

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
    .where('g.object_guid', '=', sql<string>`ANY(${ids.map(lower)}::uuid[])`)
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

/** A licensed group another group is inside, at any depth. */
export interface LicensedAncestor {
  name: string;
  skus: EntraGroupSku[];
}

/** The licensed groups each of these groups is inside, by the inner group's objectGUID. */
async function licensedAncestors(
  db: Kysely<DB>,
  providerId: number,
  ids: readonly string[],
): Promise<Map<string, LicensedAncestor[]>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<{ start: string; name: string | null; skus: EntraGroupSku[] }>`
    WITH RECURSIVE up (start, parent, depth) AS (
      SELECT member_group_object_guid, group_object_guid, 1
        FROM group_group_memberships
       WHERE provider_id = ${providerId}
         AND member_group_object_guid = ANY(${ids.map(lower)}::uuid[])
      UNION
      SELECT up.start, m.group_object_guid, up.depth + 1
        FROM up
        JOIN group_group_memberships m
          ON m.provider_id = ${providerId} AND m.member_group_object_guid = up.parent
       WHERE up.depth < ${MAX_DEPTH}
    )
    SELECT DISTINCT up.start::text AS start, p.name, l.skus
      FROM up
      JOIN group_cache_records p
        ON p.provider_id = ${providerId} AND p.object_guid = up.parent AND p.deleted_at IS NULL
      JOIN entra_group_licenses l
        ON l.provider_id = ${providerId} AND l.on_premises_sid = p.sid
  `.execute(db);
  const out = new Map<string, LicensedAncestor[]>();
  for (const r of rows) {
    if (r.skus.length === 0) continue;
    const start = lower(r.start);
    out.set(start, [...(out.get(start) ?? []), { name: r.name ?? 'a group', skus: r.skus }]);
  }
  return out;
}

type Rows = readonly { groups?: readonly string[] | undefined }[];

/** Each product the rows' groups grant directly, and how many of the rows get it. */
export function wantedSeats(
  rows: Rows,
  licensed: ReadonlyMap<string, LicensedGroup>,
): Map<string, { sku: EntraGroupSku; people: number }> {
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
  return wanted;
}

/**
 * A warning for each product with fewer seats free than the people it
 * goes to. Free is enabled + warning − consumed: Graph's warning units
 * belong to a subscription in its grace period, still assignable until
 * it lapses; suspended and locked-out units can't be assigned.
 */
export function seatWarnings(
  wanted: ReadonlyMap<string, { sku: EntraGroupSku; people: number }>,
  seats: ReadonlyMap<string, SkuSeats>,
): ImportCheckIssue[] {
  const warnings: ImportCheckIssue[] = [];
  for (const [key, { sku, people: n }] of wanted) {
    const held = seats.get(key);
    const free = Math.max(0, (held?.enabled ?? 0) + (held?.warning ?? 0) - (held?.consumed ?? 0));
    if (n <= free) continue;
    const name = skuName(sku.skuId, held?.skuPartNumber ?? sku.skuPartNumber);
    const graced = Math.min(held?.warning ?? 0, free);
    const what = !held
      ? 'the tenant has no subscription to it'
      : free === 0
        ? 'none is free'
        : `only ${free} ${free === 1 ? 'is' : 'are'} free${graced ? `, ${graced} of them in a subscription’s grace period that will lapse` : ''}`;
    warnings.push({
      row: null,
      kind: 'license_seats',
      message: `${name}: ${n === 1 ? '1 person joins' : `${n} people join`} groups that grant it, but ${what}. Entra won’t assign it to ${n - free} of them until licenses are bought or freed up.`,
    });
  }
  return warnings;
}

/**
 * A warning for each product some rows would only get through a group
 * nested in one that grants it: rows whose own groups grant it directly
 * aren't counted.
 */
export function nestedWarnings(
  rows: Rows,
  licensed: ReadonlyMap<string, LicensedGroup>,
  ancestors: ReadonlyMap<string, readonly LicensedAncestor[]>,
  groupName: (id: string) => string,
): ImportCheckIssue[] {
  const missed = new Map<
    string,
    { sku: EntraGroupSku; rows: Set<number>; inner: Set<string>; outer: Set<string> }
  >();
  rows.forEach((r, i) => {
    const groups = (r.groups ?? []).map(lower);
    const direct = new Set(
      groups.flatMap((g) => (licensed.get(g)?.skus ?? []).map((s) => lower(s.skuId))),
    );
    for (const g of groups) {
      for (const a of ancestors.get(g) ?? []) {
        for (const sku of a.skus) {
          const key = lower(sku.skuId);
          if (direct.has(key)) continue;
          const entry = missed.get(key) ?? {
            sku,
            rows: new Set(),
            inner: new Set(),
            outer: new Set(),
          };
          entry.rows.add(i);
          entry.inner.add(groupName(g));
          entry.outer.add(a.name);
          missed.set(key, entry);
        }
      }
    }
  });
  return [...missed.values()].map(({ sku, rows: who, inner, outer }) => ({
    row: null,
    kind: 'license_nested' as const,
    message: `${who.size === 1 ? '1 person' : `${who.size} people`} would only get ${skuName(sku.skuId, sku.skuPartNumber)} through nesting: ${quoted(inner)} ${inner.size === 1 ? 'is' : 'are'} inside ${quoted(outer)}, but group-based licensing doesn’t follow nested groups. License ${quoted(inner)} directly, or add them to ${quoted(outer)} too.`,
  }));
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
  rows: Rows,
): Promise<ImportCheckIssue[]> {
  const { db, providerId } = deps;
  const groupIds = [...new Set(rows.flatMap((r) => (r.groups ?? []).map(lower)))];
  if (groupIds.length === 0) return [];
  const licensed = await licensedGroupsById(db, providerId, groupIds);
  const warnings: ImportCheckIssue[] = [];

  const wanted = wantedSeats(rows, licensed);
  if (wanted.size > 0) {
    try {
      warnings.push(...seatWarnings(wanted, await subscribedSeats(deps.graph)));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      warnings.push({
        row: null,
        kind: 'license_seats',
        message: `Couldn’t check the free licenses in Entra: ${why}`,
      });
    }
  }

  const ancestors = await licensedAncestors(db, providerId, groupIds);
  const names = await findCachedGroupsById(db, providerId, [...ancestors.keys()]);
  warnings.push(...nestedWarnings(rows, licensed, ancestors, (id) => names.get(id)?.name ?? id));
  return warnings;
}
