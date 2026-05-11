// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  groupPolicyDetailSchema,
  groupPolicyListResponseSchema,
  type GroupPolicyDetail,
  type GroupPolicyLink,
  type GroupPolicyListResponse,
  type GroupPolicySummary,
} from '@openaduc/shared';
import { NotFound } from '../plugins/errorHandler.js';

const idParamSchema = z.object({ id: z.string().uuid() });

/**
 * Group Policy routes — read-only, cache-backed.
 *
 * The policies.full sync task (default daily cadence) populates
 * directory_group_policies and directory_group_policy_links from two LDAP
 * queries: groupPolicyContainer entries and the gPLink scan. These routes
 * read from those tables — no live LDAP per request. The cache row's
 * synced_at surfaces as `fetchedAt` so the UI can label freshness.
 *
 * Capability gate: `read:group`. Group Policy is conceptually closer to
 * group/OU configuration than user data, and the existing `read:group`
 * capability is the closest analogue without minting a new permission for
 * a read-only feature.
 */
export async function registerPolicyRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/policies/groups ----------------------------------------
  app.get('/api/policies/groups', {
    preHandler: app.requireCapability('read:group'),
    handler: async (req): Promise<GroupPolicyListResponse> => {
      const provider = await app.services.providers.buildForRequest(req);

      const [policyRows, linkRows] = await Promise.all([
        app.db
          .selectFrom('directory_group_policies')
          .where('provider_id', '=', provider.id)
          .where('deleted_at', 'is', null)
          .selectAll()
          .execute(),
        app.db
          .selectFrom('directory_group_policy_links')
          .where('provider_id', '=', provider.id)
          .select(['gpo_guid'])
          .execute(),
      ]);

      const linkCountByGuid = new Map<string, number>();
      for (const l of linkRows) {
        const key = l.gpo_guid.toUpperCase();
        linkCountByGuid.set(key, (linkCountByGuid.get(key) ?? 0) + 1);
      }

      const fetchedAt = latestSyncedAt(policyRows);
      const policies = policyRows
        .map((p) => rowToSummary(p, linkCountByGuid.get(p.gpo_guid.toUpperCase()) ?? 0))
        .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''));

      return groupPolicyListResponseSchema.parse({ policies, fetchedAt });
    },
  });

  // ---- GET /api/policies/groups/:id ------------------------------------
  // `:id` is the AD-assigned objectGUID (canonical UUID), matching the
  // identifier the list response surfaces.
  app.get('/api/policies/groups/:id', {
    preHandler: app.requireCapability('read:group'),
    handler: async (req): Promise<{ policy: GroupPolicyDetail }> => {
      const { id } = idParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);

      const policy = await app.db
        .selectFrom('directory_group_policies')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null)
        // object_guid is uuid; pg accepts the textual form in either case
        // and canonicalizes on compare, so no lower() needed (and uuid has
        // no lower()).
        .where('object_guid', '=', id)
        .selectAll()
        .executeTakeFirst();
      if (!policy) throw NotFound('group policy not found');

      const links = await app.db
        .selectFrom('directory_group_policy_links')
        .where('provider_id', '=', provider.id)
        .where(sql<string>`upper(gpo_guid)`, '=', policy.gpo_guid.toUpperCase())
        .orderBy('scope_dn', 'asc')
        .orderBy('link_order', 'asc')
        .selectAll()
        .execute();

      const summary = rowToSummary(policy, links.length);
      const detail: GroupPolicyDetail = {
        ...summary,
        functionalityVersion: policy.functionality_version,
        rawAttributes: policy.raw_attributes_json as Record<string, unknown>,
        links: links.map(rowToLink),
        fetchedAt: (policy.synced_at instanceof Date
          ? policy.synced_at.toISOString()
          : (policy.synced_at as unknown as string | null)) ?? new Date(0).toISOString(),
      };
      return { policy: groupPolicyDetailSchema.parse(detail) };
    },
  });
}

interface PolicyRow {
  object_guid: string;
  gpo_guid: string;
  distinguished_name: string;
  display_name: string | null;
  file_sys_path: string | null;
  version_number_raw: number | null;
  user_version: number | null;
  computer_version: number | null;
  flags_raw: number | null;
  user_policy_enabled: boolean;
  computer_policy_enabled: boolean;
  wmi_filter_ref: string | null;
  computer_extension_guids: unknown;
  user_extension_guids: unknown;
  created_at_source: Date | null;
  modified_at_source: Date | null;
  synced_at: Date | null;
}

function rowToSummary(p: PolicyRow, linkCount: number): GroupPolicySummary {
  return {
    id: p.object_guid,
    gpoGuid: p.gpo_guid,
    distinguishedName: p.distinguished_name,
    displayName: p.display_name,
    fileSysPath: p.file_sys_path,
    versionNumberRaw: p.version_number_raw,
    userVersion: p.user_version,
    computerVersion: p.computer_version,
    flagsRaw: p.flags_raw,
    userPolicyEnabled: p.user_policy_enabled,
    computerPolicyEnabled: p.computer_policy_enabled,
    wmiFilterRef: p.wmi_filter_ref,
    computerExtensionGuids: toStringArray(p.computer_extension_guids),
    userExtensionGuids: toStringArray(p.user_extension_guids),
    createdAtSource: toIso(p.created_at_source),
    modifiedAtSource: toIso(p.modified_at_source),
    linkCount,
  };
}

interface LinkRow {
  scope_dn: string;
  link_order: number;
  flags_raw: number;
  enabled: boolean;
  enforced: boolean;
}

function rowToLink(l: LinkRow): GroupPolicyLink {
  return {
    scopeDn: l.scope_dn,
    order: l.link_order,
    flagsRaw: l.flags_raw,
    enabled: l.enabled,
    enforced: l.enforced,
  };
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

function latestSyncedAt(rows: { synced_at: Date | string | null }[]): string {
  let latest = 0;
  for (const r of rows) {
    if (!r.synced_at) continue;
    const t = r.synced_at instanceof Date ? r.synced_at.getTime() : Date.parse(String(r.synced_at));
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return new Date(latest).toISOString();
}
