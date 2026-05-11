// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  groupDetailSchema,
  groupSearchQuerySchema,
  groupSearchResponseSchema,
  type GroupDetail,
  type GroupSearchResponse,
} from '@openaduc/shared';
import { NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';

const idParamSchema = z.object({ id: z.string().uuid() });

export async function registerGroupRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/groups (cache search) ----------------------------------
  app.get('/api/groups', {
    preHandler: app.requireCapability('read:group'),
    handler: async (req): Promise<GroupSearchResponse> => {
      const q = groupSearchQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);
      const offset = (q.page - 1) * q.pageSize;

      // Each group's member count comes from `user_group_memberships`.
      // We pre-aggregate it as a subquery on the same query so paging and
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

      // hasMembers narrows by the aggregated count from user_group_memberships.
      // We use EXISTS rather than joining (which would double-count) — the
      // count subquery is reattached below for the page rows.
      if (q.hasMembers === 'yes') {
        baseQuery = baseQuery.where((eb) =>
          eb.exists(
            eb
              .selectFrom('user_group_memberships as mh')
              .select(eb.lit(1).as('one'))
              .whereRef('mh.provider_id', '=', 'g.provider_id')
              .whereRef('mh.group_object_guid', '=', 'g.object_guid'),
          ),
        );
      } else if (q.hasMembers === 'no') {
        baseQuery = baseQuery.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('user_group_memberships as mh')
                .select(eb.lit(1).as('one'))
                .whereRef('mh.provider_id', '=', 'g.provider_id')
                .whereRef('mh.group_object_guid', '=', 'g.object_guid'),
            ),
          ),
        );
      }

      const SORT_MAP: Record<string, string> = {
        name: 'g.name',
        samAccountName: 'g.sam_account_name',
        memberCount: 'member_count',
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
          .select([
            'g.object_guid as id',
            'g.name as name',
            'g.sam_account_name as samAccountName',
            'g.distinguished_name as distinguishedName',
            'g.description as description',
            'g.group_type as groupType',
            'g.group_scope as groupScope',
            sql<string>`coalesce(m.member_count, '0')`.as('memberCount'),
          ])
          .orderBy(sql.ref(orderColumn), orderDir)
          .orderBy('g.id', 'asc')
          .limit(q.pageSize)
          .offset(offset)
          .execute(),
        baseQuery.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirst(),
      ]);

      const result: GroupSearchResponse = {
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
  // Live-refresh the group from AD, then attach the cached member list (which
  // the sync rebuilds from each user's `memberOf`). For very large groups
  // (thousands of members) we defer paging to a follow-up; for now the cap
  // is the sync's pageSize.
  app.get('/api/groups/:id', {
    preHandler: app.requireCapability('read:group'),
    handler: async (req): Promise<{ group: GroupDetail }> => {
      const { id } = idParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);

      const live = await provider.getGroup({ kind: 'objectGuid', value: id });
      if (!live) throw NotFound('group not found');
      const liveRefreshedAt = new Date();

      // Members from cache via the memberships table — same join the sync
      // rebuilds nightly. Sort by displayName/sam for predictable scrolling.
      const members = await app.db
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
        .orderBy(sql<string>`coalesce(u.display_name, u.sam_account_name)`, 'asc')
        .execute();

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
        members: members.map((m) => ({
          id: m.id,
          samAccountName: m.samAccountName ?? '',
          userPrincipalName: m.userPrincipalName,
          displayName: m.displayName,
          email: m.email,
          enabled: m.enabled,
          locked: m.locked,
          passwordNeverExpires: m.passwordNeverExpires,
        })),
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
}
