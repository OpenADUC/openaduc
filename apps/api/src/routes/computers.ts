// SPDX-License-Identifier: BUSL-1.1
// Computer routes — read-only mirror of the users/groups patterns.
//
// Endpoints:
//   GET /api/computers           cache search (paged + filtered)
//   GET /api/computers/:id       detail (live-refreshed from AD)
//
// Both bind as the service account: cache search is purely DB; detail does a
// single live LDAP read so the operator sees the latest dnsHostName / OS /
// last logon between syncs.

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  computerDetailSchema,
  computerSearchQuerySchema,
  computerSearchResponseSchema,
  type ComputerDetail,
  type ComputerSearchResponse,
} from '@openaduc/shared';
import { NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';

const idParamSchema = z.object({ id: z.string().uuid() });

export async function registerComputerRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/computers ----------------------------------------------
  app.get('/api/computers', {
    preHandler: app.requireCapability('read:computer'),
    handler: async (req): Promise<ComputerSearchResponse> => {
      const q = computerSearchQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);
      const offset = (q.page - 1) * q.pageSize;

      let baseQuery = app.db
        .selectFrom('computer_cache_records')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null);

      if (q.q && q.q.trim().length > 0) {
        const needle = `%${q.q.trim().toLowerCase()}%`;
        baseQuery = baseQuery.where((eb) =>
          eb.or([
            eb(sql<string>`lower(coalesce(name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(sam_account_name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(dns_host_name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(description, ''))`, 'like', needle),
          ]),
        );
      }
      if (q.enabled !== undefined) baseQuery = baseQuery.where('enabled', '=', q.enabled);
      if (q.operatingSystem) {
        baseQuery = baseQuery.where('operating_system', '=', q.operatingSystem);
      }
      // Stale-since: machines whose lastLogonAt is older than N days OR null.
      // lastLogonTimestamp replicates lazily (every 9–14 days by default), so
      // a small N can produce false positives — the UI labels this as
      // "approximate".
      if (q.staleSinceDays !== undefined) {
        const cutoff = new Date(Date.now() - q.staleSinceDays * 86400_000);
        baseQuery = baseQuery.where((eb) =>
          eb.or([eb('last_logon_at', 'is', null), eb('last_logon_at', '<', cutoff)]),
        );
      }
      if (q.ou) {
        const dn = q.ou.trim();
        if (dn) {
          if (q.includeSubOus !== false) {
            baseQuery = baseQuery.where('distinguished_name', 'ilike', `%,${dn}`);
          } else {
            baseQuery = baseQuery.where(
              sql<string>`substring(distinguished_name from position(',' in distinguished_name) + 1)`,
              '=',
              dn,
            );
          }
        }
      }

      const SORT_MAP: Record<string, string> = {
        name: 'name',
        samAccountName: 'sam_account_name',
        dnsHostName: 'dns_host_name',
        operatingSystem: 'operating_system',
        lastLogonAt: 'last_logon_at',
        modifiedAtSource: 'modified_at_source',
      };
      const orderColumn = SORT_MAP[q.sort] ?? 'name';
      const orderDir = q.sortDir === 'desc' ? 'desc' : 'asc';

      const [rows, totalRow] = await Promise.all([
        baseQuery
          .select([
            'object_guid as id',
            'name',
            'sam_account_name as samAccountName',
            'distinguished_name as distinguishedName',
            'dns_host_name as dnsHostName',
            'operating_system as operatingSystem',
            'operating_system_version as operatingSystemVersion',
            'enabled',
            'last_logon_at as lastLogonAt',
            'modified_at_source as modifiedAtSource',
          ])
          .orderBy(sql.ref(orderColumn), orderDir)
          .orderBy('id', 'asc')
          .limit(q.pageSize)
          .offset(offset)
          .execute(),
        baseQuery.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirst(),
      ]);

      const result: ComputerSearchResponse = {
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          samAccountName: r.samAccountName,
          distinguishedName: r.distinguishedName,
          dnsHostName: r.dnsHostName,
          operatingSystem: r.operatingSystem,
          operatingSystemVersion: r.operatingSystemVersion,
          enabled: r.enabled,
          lastLogonAt: r.lastLogonAt ? new Date(r.lastLogonAt).toISOString() : null,
          modifiedAtSource: r.modifiedAtSource ? new Date(r.modifiedAtSource).toISOString() : null,
        })),
        total: Number(totalRow?.total ?? 0),
        page: q.page,
        pageSize: q.pageSize,
      };
      return computerSearchResponseSchema.parse(result);
    },
  });

  // ---- GET /api/computers/:id ------------------------------------------
  app.get('/api/computers/:id', {
    preHandler: app.requireCapability('read:computer'),
    handler: async (req): Promise<{ computer: ComputerDetail }> => {
      const { id } = idParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);

      // Live read so dnsHostName / OS / last logon are current. The cache
      // backstops the freshness/synced_at signal we surface to the UI.
      const live = await provider.getComputer({ kind: 'objectGuid', value: id });
      if (!live) throw NotFound('computer not found');

      // Resolve group memberships against the cache. Falls back to a DN-only
      // entry when the group isn't cached yet (newly-joined GPO groups, etc.).
      const memberDns = live.memberOfDns;
      let groupRows: { id: string; name: string | null; distinguishedName: string }[] = [];
      if (memberDns.length > 0) {
        const cached = await app.db
          .selectFrom('group_cache_records')
          .where('provider_id', '=', provider.id)
          .where('deleted_at', 'is', null)
          .where('distinguished_name', 'in', memberDns)
          .select(['object_guid as id', 'name', 'distinguished_name as distinguishedName'])
          .execute();
        const byDn = new Map(cached.map((g) => [g.distinguishedName.toLowerCase(), g] as const));
        groupRows = memberDns.map((dn) => {
          const hit = byDn.get(dn.toLowerCase());
          return hit ?? { id: '', name: null, distinguishedName: dn };
        });
      }

      // Resolve managedBy DN against the user cache (same pattern as user.manager).
      let managedBy: ComputerDetail['managedBy'] = null;
      if (live.managedByDn) {
        const row = await app.db
          .selectFrom('user_cache_records')
          .where('provider_id', '=', provider.id)
          .where('distinguished_name', '=', live.managedByDn)
          .where('deleted_at', 'is', null)
          .select(['object_guid as id', 'display_name as displayName'])
          .executeTakeFirst();
        managedBy = {
          id: row?.id ?? null,
          distinguishedName: live.managedByDn,
          displayName: row?.displayName ?? null,
        };
      }

      const cacheRow = await app.db
        .selectFrom('computer_cache_records')
        .select(['synced_at', 'stale_at'])
        .where('provider_id', '=', provider.id)
        .where('object_guid', '=', id)
        .executeTakeFirst();

      const detail: ComputerDetail = {
        id: live.objectGuid,
        name: live.name,
        samAccountName: live.samAccountName,
        distinguishedName: live.distinguishedName,
        dnsHostName: live.dnsHostName,
        operatingSystem: live.operatingSystem,
        operatingSystemVersion: live.operatingSystemVersion,
        enabled: live.enabled,
        lastLogonAt: live.lastLogonAt ? live.lastLogonAt.toISOString() : null,
        modifiedAtSource: live.modifiedAtSource ? live.modifiedAtSource.toISOString() : null,
        description: live.description,
        managedByDn: live.managedByDn,
        managedBy,
        passwordLastSetAt: live.passwordLastSetAt ? live.passwordLastSetAt.toISOString() : null,
        createdAtSource: live.createdAtSource ? live.createdAtSource.toISOString() : null,
        groupMemberships: groupRows.map((g) => ({
          id: g.id || null,
          name: g.name,
          distinguishedName: g.distinguishedName,
        })),
        freshness: {
          cachedAt: cacheRow?.synced_at ? new Date(cacheRow.synced_at).toISOString() : null,
          isStale: Boolean(cacheRow?.stale_at),
        },
        rawAttributes: live.rawAttributes,
      };

      // Audit the view, gated by the same setting as user/group views and
      // deduped per session+target so reloads don't pile on.
      if (
        (await app.services.settings.get<boolean>('audit.account_view_enabled', true)) &&
        app.services.audit.shouldRecordView(req.actor?.session.id ?? null, 'computer', detail.id)
      ) {
        await app.services.audit
          .recordEvent({
            ...auditContextFromRequest(req),
            action: 'computer.view',
            result: 'success',
            actorAuthMethod: 'ad-password',
            providerId: provider.id,
            targetType: 'computer',
            targetId: detail.id,
            targetDn: detail.distinguishedName,
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for computer.view'));
      }

      return { computer: computerDetailSchema.parse(detail) };
    },
  });
}
