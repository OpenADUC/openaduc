// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  groupCreateRequestSchema,
  groupDeletePreflightResponseSchema,
  groupDeleteRequestSchema,
  groupDetailSchema,
  groupNameCheckQuerySchema,
  groupSearchQuerySchema,
  groupSearchResponseSchema,
  type GroupDeletePreflightResponse,
  type GroupDetail,
  type GroupMember,
  type GroupNameCheckResponse,
  type GroupSearchResponse,
  type GroupSummary,
} from '@openaduc/shared';
import { describeGroupDeleteBlock, groupDeleteBlockReason } from '../lib/groupDeletion.js';
import { NotFound, Unauthorized } from '../plugins/errorHandler.js';
import { leafRdnValue } from '../providers/active-directory/normalize.js';
import { auditContextFromRequest, withAudit } from '../services/auditContext.js';
import { forgetDeletedGroup, upsertGroup } from '../services/groupCache.js';
import { findCachedOu } from '../services/ouCache.js';
import { listFreshness } from '../services/listFreshness.js';
import { directoryRefusal } from './directoryRefusal.js';
import { changeMembership } from './groupMembership.js';
import { ctx } from './writeContext.js';

const idParamSchema = z.object({ id: z.guid() });

export async function registerGroupRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/groups (cache search) ----------------------------------
  app.get('/api/groups', {
    config: { policy: { capability: 'read:group', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<GroupSearchResponse> => {
      const q = groupSearchQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);
      const offset = (q.page - 1) * q.pageSize;

      // Each group's member count is its users in `user_group_memberships`
      // plus its nested groups in `group_group_memberships`. We
      // pre-aggregate both as subqueries on the same query so paging and
      // filtering stay consistent.
      let baseQuery = app.db
        .selectFrom('group_cache_records as g')
        .where('g.provider_id', '=', provider.id)
        .where('g.deleted_at', 'is', null);

      if (q.q && q.q.trim()) {
        const needle = `%${q.q.trim().toLowerCase()}%`;
        baseQuery = baseQuery.where((eb) =>
          eb.or([
            eb(sql<string>`lower(coalesce(g.name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(g.sam_account_name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(g.description, ''))`, 'like', needle),
          ]),
        );
      }
      if (q.type) baseQuery = baseQuery.where('g.group_type', '=', q.type);
      if (q.scope) baseQuery = baseQuery.where('g.group_scope', '=', q.scope);

      // hasMembers narrows by whether either membership table has a row for
      // the group. We use EXISTS rather than joining (which would
      // double-count) — the count subquery is reattached below for the page
      // rows.
      if (q.hasMembers) {
        baseQuery = baseQuery.where((eb) => {
          const hasMembers = eb.or([
            eb.exists(
              eb
                .selectFrom('user_group_memberships as mh')
                .select(eb.lit(1).as('one'))
                .whereRef('mh.provider_id', '=', 'g.provider_id')
                .whereRef('mh.group_object_guid', '=', 'g.object_guid'),
            ),
            eb.exists(
              eb
                .selectFrom('group_group_memberships as gh')
                .select(eb.lit(1).as('one'))
                .whereRef('gh.provider_id', '=', 'g.provider_id')
                .whereRef('gh.group_object_guid', '=', 'g.object_guid'),
            ),
          ]);
          return q.hasMembers === 'yes' ? hasMembers : eb.not(hasMembers);
        });
      }

      const SORT_MAP: Record<string, string> = {
        name: 'g.name',
        samAccountName: 'g.sam_account_name',
        memberCount: 'memberCount',
        groupType: 'g.group_type',
        groupScope: 'g.group_scope',
      };
      const orderColumn = SORT_MAP[q.sort] ?? 'g.name';
      const orderDir = q.sortDir === 'desc' ? 'desc' : 'asc';

      const [rows, totalRow] = await Promise.all([
        baseQuery
          .leftJoin(
            (eb) =>
              eb
                .selectFrom('user_group_memberships')
                .select([
                  'provider_id',
                  'group_object_guid',
                  eb.fn.countAll<string>().as('member_count'),
                ])
                .where('provider_id', '=', provider.id)
                .groupBy(['provider_id', 'group_object_guid'])
                .as('m'),
            (join) =>
              join
                .onRef('m.provider_id', '=', 'g.provider_id')
                .onRef('m.group_object_guid', '=', 'g.object_guid'),
          )
          .leftJoin(
            (eb) =>
              eb
                .selectFrom('group_group_memberships')
                .select([
                  'provider_id',
                  'group_object_guid',
                  eb.fn.countAll<string>().as('member_count'),
                ])
                .where('provider_id', '=', provider.id)
                .groupBy(['provider_id', 'group_object_guid'])
                .as('n'),
            (join) =>
              join
                .onRef('n.provider_id', '=', 'g.provider_id')
                .onRef('n.group_object_guid', '=', 'g.object_guid'),
          )
          .select([
            'g.object_guid as id',
            'g.name as name',
            'g.sam_account_name as samAccountName',
            'g.distinguished_name as distinguishedName',
            'g.description as description',
            'g.group_type as groupType',
            'g.group_scope as groupScope',
            sql<string>`coalesce(m.member_count, 0) + coalesce(n.member_count, 0)`.as(
              'memberCount',
            ),
          ])
          .orderBy(sql.ref(orderColumn), orderDir)
          .orderBy('g.id', 'asc')
          .limit(q.pageSize)
          .offset(offset)
          .execute(),
        baseQuery.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirst(),
      ]);

      const result: GroupSearchResponse = {
        freshness: await listFreshness(app.db, provider.id, 'groups'),
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          samAccountName: r.samAccountName,
          distinguishedName: r.distinguishedName,
          description: r.description,
          groupType: r.groupType,
          groupScope: r.groupScope,
          memberCount: Number(r.memberCount ?? 0),
        })),
        total: Number(totalRow?.total ?? 0),
        page: q.page,
        pageSize: q.pageSize,
      };
      return groupSearchResponseSchema.parse(result);
    },
  });

  // ---- GET /api/groups/:id ---------------------------------------------
  // Live-refresh the group from AD, then attach the cached member list: users
  // (which the sync rebuilds from each user's `memberOf`) and nested groups
  // (from each group's `member`). For very large groups
  // (thousands of members) we defer paging to a follow-up; for now the cap
  // is the sync's pageSize.
  app.get('/api/groups/:id', {
    config: { policy: { capability: 'read:group', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<{ group: GroupDetail }> => {
      const { id } = idParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);

      const live = await provider.getGroup({ kind: 'objectGuid', value: id });
      if (!live) throw NotFound('group not found');
      const liveRefreshedAt = new Date();

      // Members from cache via the memberships tables — same joins the sync
      // rebuilds nightly. Sort by name for predictable scrolling.
      const users = await app.db
        .selectFrom('user_group_memberships as m')
        .innerJoin('user_cache_records as u', (join) =>
          join
            .onRef('u.provider_id', '=', 'm.provider_id')
            .onRef('u.object_guid', '=', 'm.user_object_guid'),
        )
        .where('m.provider_id', '=', provider.id)
        .where('m.group_object_guid', '=', id)
        .where('u.deleted_at', 'is', null)
        .select([
          'u.object_guid as id',
          'u.sam_account_name as samAccountName',
          'u.user_principal_name as userPrincipalName',
          'u.display_name as displayName',
          'u.email as email',
          'u.enabled as enabled',
          'u.locked as locked',
          'u.password_never_expires as passwordNeverExpires',
        ])
        .execute();
      const nested = await app.db
        .selectFrom('group_group_memberships as m')
        .innerJoin('group_cache_records as n', (join) =>
          join
            .onRef('n.provider_id', '=', 'm.provider_id')
            .onRef('n.object_guid', '=', 'm.member_group_object_guid'),
        )
        .where('m.provider_id', '=', provider.id)
        .where('m.group_object_guid', '=', id)
        .where('n.deleted_at', 'is', null)
        .select([
          'n.object_guid as id',
          'n.name as name',
          'n.sam_account_name as samAccountName',
          'n.distinguished_name as distinguishedName',
          'n.description as description',
          'n.group_type as groupType',
          'n.group_scope as groupScope',
        ])
        .execute();
      const members: GroupMember[] = [
        ...users.map((m) => ({
          kind: 'user' as const,
          id: m.id,
          samAccountName: m.samAccountName ?? '',
          userPrincipalName: m.userPrincipalName,
          displayName: m.displayName,
          email: m.email,
          enabled: m.enabled,
          locked: m.locked,
          passwordNeverExpires: m.passwordNeverExpires,
        })),
        ...nested.map((g) => ({ kind: 'group' as const, ...g })),
      ];
      const label = (m: GroupMember) =>
        (m.kind === 'user' ? m.displayName || m.samAccountName : m.name || m.samAccountName) ??
        m.id;
      members.sort((a, b) => label(a).localeCompare(label(b)));

      const cacheRow = await app.db
        .selectFrom('group_cache_records')
        .select(['synced_at'])
        .where('provider_id', '=', provider.id)
        .where('object_guid', '=', id)
        .executeTakeFirst();

      const detail: GroupDetail = {
        id: live.objectGuid,
        name: live.name,
        samAccountName: live.samAccountName,
        distinguishedName: live.distinguishedName,
        description: live.description,
        groupType: live.groupType,
        groupScope: live.groupScope,
        email: live.email,
        memberCount: members.length,
        members,
        freshness: {
          cachedAt: cacheRow?.synced_at ? new Date(cacheRow.synced_at).toISOString() : null,
          liveRefreshedAt: liveRefreshedAt.toISOString(),
        },
      };

      // Group views are audited the same way user views are, gated by the
      // existing setting since the volume is similar — and deduped per
      // session+target so reloads don't pile on.
      if (
        (await app.services.settings.get<boolean>('audit.account_view_enabled', true)) &&
        app.services.audit.shouldRecordView(req.actor?.session.id ?? null, 'group', detail.id)
      ) {
        await app.services.audit
          .recordEvent({
            ...auditContextFromRequest(req),
            action: 'group.view',
            result: 'success',
            actorAuthMethod: 'ad-password',
            providerId: provider.id,
            targetType: 'group',
            targetId: detail.id,
            targetDn: detail.distinguishedName,
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for group.view'));
      }

      return { group: groupDetailSchema.parse(detail) };
    },
  });

  // ---- GET /api/groups/name-check --------------------------------------
  // Whether a new group's names are free, so the create dialog can say so
  // before the operator submits. The create checks again.
  app.get('/api/groups/name-check', {
    config: { policy: { capability: 'write:group.create', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<GroupNameCheckResponse> => {
      const q = groupNameCheckQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);
      const parentDn = (await findCachedOu(app.db, provider.id, q.parentDn))?.distinguished_name;
      if (!parentDn) throw app.httpErrors.badRequest('OU not found in directory cache');
      const holders = await provider.findNameHolders({
        parentDn,
        cn: q.name,
        samAccountName: q.samAccountName,
      });
      return { nameTakenBy: holders.cn, samAccountNameTakenBy: holders.samAccountName };
    },
  });

  // ---- POST /api/groups (create in an OU) ------------------------------
  app.post('/api/groups', {
    config: { policy: { capability: 'write:group.create', stepUp: true, directory: 'caller' } },
    handler: async (req): Promise<{ ok: true; group: GroupSummary }> => {
      const body = groupCreateRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);
      const parentDn = (await findCachedOu(app.db, provider.id, body.parentDn))?.distinguished_name;
      if (!parentDn) throw app.httpErrors.badRequest('OU not found in directory cache');

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'group.create',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'group',
          targetDn: `CN=${body.name},${parentDn}`,
          metadata: {
            parentDn,
            name: body.name,
            samAccountName: body.samAccountName,
            scope: body.scope,
            type: body.type,
          },
        },
        async () => {
          const r = await provider.createGroup(
            {
              parentDn,
              cn: body.name,
              samAccountName: body.samAccountName,
              description: body.description || null,
              scope: body.scope,
              type: body.type,
            },
            ctx(actor, req),
          );
          return {
            ok: r.ok,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
            errorMessage: r.errorMessage ?? null,
            targetId: r.group?.objectGuid ?? null,
            group: r.group ?? null,
          };
        },
      );

      if (!result.ok || !result.group) {
        throw directoryRefusal(app, result, { verb: 'create', notFound: 'OU not found' });
      }

      const g = result.group;
      await upsertGroup(app.db, provider.id, g);
      return {
        ok: true,
        group: {
          id: g.objectGuid,
          name: g.name,
          samAccountName: g.samAccountName,
          distinguishedName: g.distinguishedName,
          description: g.description,
          groupType: g.groupType,
          groupScope: g.groupScope,
          memberCount: 0,
        },
      };
    },
  });

  // ---- GET /api/groups/:id/delete-preflight ----------------------------
  // What the delete confirmation shows: how many members the group has,
  // which groups it's in, and why it can't be deleted if it can't. Read
  // live; the delete checks again.
  app.get('/api/groups/:id/delete-preflight', {
    config: { policy: { capability: 'write:group.delete', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<GroupDeletePreflightResponse> => {
      const { id } = idParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);
      const live = await provider.getGroup({ kind: 'objectGuid', value: id });
      if (!live) throw NotFound('group not found');

      const dnsLower = live.memberOfDns.map((d) => d.toLowerCase());
      const cached =
        dnsLower.length === 0
          ? []
          : await app.db
              .selectFrom('group_cache_records')
              .select(['object_guid', 'name', 'distinguished_name'])
              .where('provider_id', '=', provider.id)
              .where('deleted_at', 'is', null)
              .where(sql<string>`lower(distinguished_name)`, 'in', dnsLower)
              .execute();
      const byDn = new Map(cached.map((r) => [r.distinguished_name.toLowerCase(), r]));

      return groupDeletePreflightResponseSchema.parse({
        id: live.objectGuid,
        name: live.name,
        samAccountName: live.samAccountName,
        distinguishedName: live.distinguishedName,
        memberCount: live.memberDns.length,
        memberOf: live.memberOfDns.map((dn) => {
          const hit = byDn.get(dn.toLowerCase());
          return {
            id: hit?.object_guid ?? null,
            name: hit?.name ?? leafRdnValue(dn),
            distinguishedName: dn,
          };
        }),
        blockedReason: groupDeleteBlockReason(live),
      });
    },
  });

  // ---- DELETE /api/groups/:id ------------------------------------------
  // Body: { confirmSamAccountName }.
  app.delete('/api/groups/:id', {
    config: { policy: { capability: 'write:group.delete', stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = groupDeleteRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      const live = await provider.getGroup({ kind: 'objectGuid', value: id });
      if (!live) throw NotFound('group not found');
      if (
        !live.samAccountName ||
        live.samAccountName.toLowerCase() !== body.confirmSamAccountName.trim().toLowerCase()
      ) {
        throw app.httpErrors.badRequest(
          'confirmation does not match the group’s pre-Windows 2000 name',
        );
      }
      // Refuse before writing an audit row: nothing was attempted. The
      // provider repeats this check on its own read right before the delete.
      const blocked = groupDeleteBlockReason(live);
      if (blocked) {
        throw app.httpErrors.conflict(`cannot delete: ${describeGroupDeleteBlock(blocked)}`);
      }

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'group.delete',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'group',
          targetId: live.objectGuid,
          targetDn: live.distinguishedName,
          metadata: { samAccountName: live.samAccountName, memberCount: live.memberDns.length },
        },
        async () => {
          const r = await provider.deleteGroup({ kind: 'objectGuid', value: id }, ctx(actor, req));
          return {
            ok: r.ok,
            before: r.before ?? null,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
            errorMessage: r.errorMessage ?? null,
          };
        },
      );

      if (!result.ok) {
        throw directoryRefusal(app, result, {
          verb: 'delete',
          notFound: 'group not found',
          forbidden:
            'directory refused the delete — you may lack the Delete right, or the group is protected from accidental deletion',
        });
      }

      await forgetDeletedGroup(app.db, provider.id, live.objectGuid);
      return { ok: true };
    },
  });

  // ---- POST /api/groups/:id/groups (nest) + DELETE (take out) ----------
  // Body: { groupId }, the group that :id joins or leaves. The same change
  // as /api/users/:id/groups, for a group.
  app.post('/api/groups/:id/groups', {
    config: { policy: { capability: 'write:group.membership', stepUp: true, directory: 'caller' } },
    handler: async (req) => changeMembership(app, req, 'group', 'add'),
  });

  app.delete('/api/groups/:id/groups', {
    config: { policy: { capability: 'write:group.membership', stepUp: true, directory: 'caller' } },
    handler: async (req) => changeMembership(app, req, 'group', 'remove'),
  });
}
