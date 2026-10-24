// SPDX-License-Identifier: BUSL-1.1
import {
  LICENSE_ASSIGNMENT_ERRORS,
  type GroupLicenses,
  type LicenseAssignment,
  type LicenseAssignmentError,
  type LicenseGroup,
  type LicenseSku,
  type UserLicenses,
} from '@openaduc/shared';
import { z } from 'zod';
import type { EntraGroupSku } from '../db/types.js';
import { byName, licenseSku } from '../lib/skuNames.js';
import {
  allPages,
  findEntraGroup,
  findEntraUser,
  listOf,
  tenantLastSync,
  type GraphReader,
} from './entraLookup.js';
import { GraphPermissionError } from './graphClient.js';

// Reading Microsoft licenses from Entra: a user's, with the group or direct
// assignment each comes from and any error assigning it, and a group's.
// Read-only; OpenADUC never assigns a license.

export interface LicenseDeps {
  graph: GraphReader;
  /** The cached AD groups with these SIDs, as objectGUID by SID. */
  adGroupsBySid: (sids: string[]) => Promise<Map<string, string>>;
  now?: () => Date;
}

/** An Entra group that grants licenses, as the cache keeps it. */
export interface LicensedEntraGroup {
  entraGroupId: string;
  displayName: string | null;
  onPremisesSid: string | null;
  skus: EntraGroupSku[];
}

const SKUS_PATH = '/subscribedSkus?$select=skuId,skuPartNumber';
// Subscriptions change rarely. A failed read (most likely a permission
// not yet granted) is retried sooner, so a grant shows without a restart.
const SKUS_TTL_MS = 60 * 60_000;
const SKUS_RETRY_MS = 5 * 60_000;
// Graph's `in` filter takes at most 15 values.
const FILTER_IN_MAX = 15;

const assignedLicenseSchema = z.object({
  skuId: z.string(),
  disabledPlans: z.array(z.string()).nullish(),
});
const assignmentStateSchema = z.object({
  skuId: z.string(),
  assignedByGroup: z.string().nullish(),
  state: z.string().nullish(),
  error: z.string().nullish(),
  disabledPlans: z.array(z.string()).nullish(),
  lastUpdatedDateTime: z.string().nullish(),
});
const entraGroupSchema = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  onPremisesSecurityIdentifier: z.string().nullish(),
  assignedLicenses: z.array(assignedLicenseSchema).nullish(),
  licenseProcessingState: z
    .union([z.string(), z.object({ state: z.string().nullish() })])
    .nullish(),
});
const skuSchema = z.object({ skuId: z.string(), skuPartNumber: z.string().nullish() });

const STATES: Record<string, LicenseAssignment['state']> = {
  active: 'active',
  activewitherror: 'activeWithError',
  disabled: 'disabled',
  error: 'error',
};

// Per Graph client, so new credentials (a new client) read them afresh.
const skuCache = new WeakMap<GraphReader, { parts: Map<string, string>; until: number }>();

/** The tenant's part number for each SKU it subscribes to; empty when Graph won't say. */
async function skuPartNumbers(graph: GraphReader, now: Date): Promise<Map<string, string>> {
  const cached = skuCache.get(graph);
  if (cached && now.getTime() < cached.until) return cached.parts;
  const parts = new Map<string, string>();
  let ttl = SKUS_TTL_MS;
  try {
    for (const sku of listOf(skuSchema).parse((await graph.getJson(SKUS_PATH)).data).value) {
      if (sku.skuPartNumber) parts.set(sku.skuId.toLowerCase(), sku.skuPartNumber);
    }
  } catch (err) {
    if (!(err instanceof GraphPermissionError)) throw err;
    ttl = SKUS_RETRY_MS;
  }
  skuCache.set(graph, { parts, until: now.getTime() + ttl });
  return parts;
}

const seatsSchema = skuSchema.extend({
  consumedUnits: z.number().nullish(),
  prepaidUnits: z
    .object({ enabled: z.number().nullish(), warning: z.number().nullish() })
    .nullish(),
});

/** How many of a product the tenant has, and how many are assigned. */
export interface SkuSeats {
  skuId: string;
  skuPartNumber: string | null;
  /** Units of active subscriptions. */
  enabled: number;
  /** Units of lapsed subscriptions in their grace period: still usable, not for long. */
  warning: number;
  consumed: number;
}

/** The tenant's seats in each product it subscribes to, by SKU id (lower case), read live. */
export async function subscribedSeats(graph: GraphReader): Promise<Map<string, SkuSeats>> {
  const res = await graph.getJson(
    '/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits',
  );
  return new Map(
    listOf(seatsSchema)
      .parse(res.data)
      .value.map((s) => [
        s.skuId.toLowerCase(),
        {
          skuId: s.skuId,
          skuPartNumber: s.skuPartNumber ?? null,
          enabled: s.prepaidUnits?.enabled ?? 0,
          warning: s.prepaidUnits?.warning ?? 0,
          consumed: s.consumedUnits ?? 0,
        },
      ]),
  );
}

/** The licenses of the AD user with this SID, each with where it comes from. */
export async function userLicenses(deps: LicenseDeps, sid: string): Promise<UserLicenses> {
  const { graph } = deps;
  const now = deps.now?.() ?? new Date();
  const entraUserId = await findEntraUser(graph, sid);
  if (!entraUserId) return { status: 'unsynced', lastSyncAt: await tenantLastSync(graph) };

  const states = await assignmentStates(graph, entraUserId);
  const [parts, groups] = await Promise.all([
    skuPartNumbers(graph, now),
    licenseGroups(
      deps,
      states.flatMap((s) => (s.assignedByGroup ? [s.assignedByGroup] : [])),
    ),
  ]);

  const bySku = new Map<string, { sku: LicenseSku; assignments: LicenseAssignment[] }>();
  for (const s of states) {
    const key = s.skuId.toLowerCase();
    const entry = bySku.get(key) ?? {
      sku: licenseSku(s.skuId, parts.get(key) ?? null),
      assignments: [],
    };
    bySku.set(key, entry);
    entry.assignments.push({
      group: s.assignedByGroup ? groups.get(s.assignedByGroup)! : null,
      state: assignmentState(s),
      error: assignmentError(s.error),
      disabledPlanCount: s.disabledPlans?.length ?? 0,
      lastUpdatedAt: s.lastUpdatedDateTime ? new Date(s.lastUpdatedDateTime).toISOString() : null,
    });
  }
  const licenses = [...bySku.values()].map(({ sku, assignments }) => ({
    ...sku,
    assignments: assignments.sort(
      (a, b) =>
        Number(a.group !== null) - Number(b.group !== null) ||
        (a.group?.name ?? '').localeCompare(b.group?.name ?? ''),
    ),
  }));
  return { status: 'synced', licenses: licenses.sort(byName) };
}

/** The user's licenseAssignmentStates, as Graph lists them. */
export async function assignmentStates(
  graph: GraphReader,
  entraUserId: string,
): Promise<z.infer<typeof assignmentStateSchema>[]> {
  const user = z
    .object({ licenseAssignmentStates: z.array(assignmentStateSchema).nullish() })
    .parse(
      (
        await graph.getJson(
          `/users/${encodeURIComponent(entraUserId)}?$select=id,licenseAssignmentStates`,
        )
      ).data,
    );
  return user.licenseAssignmentStates ?? [];
}

export function assignmentState(s: {
  state?: string | null | undefined;
  error?: string | null | undefined;
}): LicenseAssignment['state'] {
  return STATES[(s.state ?? '').toLowerCase()] ?? (assignmentError(s.error) ? 'error' : 'active');
}

export function assignmentError(raw: string | null | undefined): LicenseAssignmentError | null {
  if (!raw || raw === 'None') return null;
  return (LICENSE_ASSIGNMENT_ERRORS as readonly string[]).includes(raw)
    ? (raw as LicenseAssignmentError)
    : 'Other';
}

/**
 * The groups with these Entra ids, named, and linked to the AD group each
 * is synced from. A group Entra won't describe keeps only its id.
 */
async function licenseGroups(
  deps: LicenseDeps,
  entraIds: string[],
): Promise<Map<string, LicenseGroup>> {
  const ids = [...new Set(entraIds)];
  const found: z.infer<typeof entraGroupSchema>[] = [];
  try {
    for (let i = 0; i < ids.length; i += FILTER_IN_MAX) {
      const list = ids
        .slice(i, i + FILTER_IN_MAX)
        .map((id) => `'${id.replace(/'/g, "''")}'`)
        .join(',');
      const page = await allPages(
        deps.graph,
        `/groups?$filter=id in (${list})&$select=id,displayName,onPremisesSecurityIdentifier`,
        entraGroupSchema,
      );
      found.push(...(page ?? []));
    }
  } catch (err) {
    if (!(err instanceof GraphPermissionError)) throw err;
  }
  const sids = found.flatMap((g) =>
    g.onPremisesSecurityIdentifier ? [g.onPremisesSecurityIdentifier] : [],
  );
  const adGroups = sids.length ? await deps.adGroupsBySid(sids) : new Map<string, string>();
  const groups = new Map<string, LicenseGroup>(
    ids.map((id) => [id, { entraGroupId: id, name: null, groupId: null }]),
  );
  for (const g of found) {
    groups.set(g.id, {
      entraGroupId: g.id,
      name: g.displayName ?? null,
      groupId: g.onPremisesSecurityIdentifier
        ? (adGroups.get(g.onPremisesSecurityIdentifier) ?? null)
        : null,
    });
  }
  return groups;
}

/**
 * The licenses the AD group with this SID grants, read live, and the group
 * as the cache keeps it (null when it isn't in Entra).
 */
export async function groupLicenses(
  deps: Pick<LicenseDeps, 'graph' | 'now'>,
  sid: string,
): Promise<{ licenses: GroupLicenses; entraGroup: LicensedEntraGroup | null }> {
  const { graph } = deps;
  const now = deps.now?.() ?? new Date();
  const entraGroupId = await findEntraGroup(graph, sid);
  if (!entraGroupId) {
    return {
      licenses: { status: 'unsynced', lastSyncAt: await tenantLastSync(graph) },
      entraGroup: null,
    };
  }
  const group = entraGroupSchema.parse(
    (
      await graph.getJson(
        `/groups/${encodeURIComponent(entraGroupId)}?$select=id,displayName,onPremisesSecurityIdentifier,assignedLicenses,licenseProcessingState`,
      )
    ).data,
  );
  const parts = await skuPartNumbers(graph, now);
  const entraGroup = toCached(group, parts);
  const processing = group.licenseProcessingState;
  return {
    licenses: {
      status: 'synced',
      licenses: entraGroup.skus
        .map((s) => ({
          ...licenseSku(s.skuId, s.skuPartNumber),
          disabledPlanCount: s.disabledPlanCount,
        }))
        .sort(byName),
      processingState: (typeof processing === 'string' ? processing : processing?.state) ?? null,
    },
    entraGroup,
  };
}

// Filtering on a collection's $count is an advanced query, which a plain
// list would refuse.
const LICENSED_GROUPS_PATH =
  '/groups?$filter=assignedLicenses/$count ne 0&$count=true&$select=id,displayName,onPremisesSecurityIdentifier,assignedLicenses&$top=999';

/** Every group in the tenant that grants a license, for the cache. */
export async function licensedEntraGroups(
  deps: Pick<LicenseDeps, 'graph' | 'now'>,
): Promise<LicensedEntraGroup[]> {
  const now = deps.now?.() ?? new Date();
  const groups = await allPages(deps.graph, LICENSED_GROUPS_PATH, entraGroupSchema, {
    ConsistencyLevel: 'eventual',
  });
  // A partial list would drop the badge from groups it missed.
  if (!groups) throw new Error('too many licensed groups to list in one run');
  const parts = await skuPartNumbers(deps.graph, now);
  return groups.map((g) => toCached(g, parts));
}

function toCached(
  group: z.infer<typeof entraGroupSchema>,
  parts: Map<string, string>,
): LicensedEntraGroup {
  return {
    entraGroupId: group.id,
    displayName: group.displayName ?? null,
    onPremisesSid: group.onPremisesSecurityIdentifier ?? null,
    skus: (group.assignedLicenses ?? []).map((l) => ({
      skuId: l.skuId,
      skuPartNumber: parts.get(l.skuId.toLowerCase()) ?? null,
      disabledPlanCount: l.disabledPlans?.length ?? 0,
    })),
  };
}
