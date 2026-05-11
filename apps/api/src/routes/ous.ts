// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  directoryOuSchema,
  ouContentsResponseSchema,
  ouCreateRequestSchema,
  ouDeleteRequestSchema,
  ouListResponseSchema,
  ouUpdateRequestSchema,
  type DirectoryOu,
  type OuContentsResponse,
  type OuListResponse,
} from '@openaduc/shared';
import { stringifyForJsonb } from '../lib/jsonbSafe.js';
import { Unauthorized } from '../plugins/errorHandler.js';
import { leafRdn, parentDn } from '../providers/active-directory/normalize.js';
import { auditContextFromRequest, withAudit } from '../services/auditContext.js';

const dnQuerySchema = z.object({
  // The OU's distinguishedName. Comes from the cached `directory_ous` table —
  // the route validates the value against the cache before executing the
  // contents query, so an arbitrary string can't be used to scan the user/
  // group tables for unrelated DNs.
  dn: z.string().min(1).max(1024),
});

export async function registerOuRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/ous (flat list of OUs for the active provider) ---------
  // Returns every non-deleted OU; the client builds the tree from `parentDn`.
  // Stale entries are still returned (with `stale: true`) so the operator
  // can see OUs that haven't shown up in the most recent sync rather than
  // having them silently disappear.
  app.get('/api/ous', {
    preHandler: app.requireCapability('read:user'),
    handler: async (req): Promise<OuListResponse> => {
      const provider = await app.services.providers.buildForRequest(req);
      const rows = await app.db
        .selectFrom('directory_ous')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null)
        .select([
          'distinguished_name',
          'name',
          'parent_dn',
          'stale_at',
          // AD's `description` lives inside raw_attributes_json. The
          // wildcard sync pulls it through; we extract here rather than
          // promoting it to a column. `->>` returns text (or NULL when
          // absent). Multi-valued descriptions (rare) come through as a
          // JSON array — we'd see the textual form `["foo","bar"]`. The
          // route accepts either; the UI just renders it as-is.
          sql<string | null>`raw_attributes_json ->> 'description'`.as('description'),
        ])
        .orderBy('distinguished_name', 'asc')
        .execute();
      const ous: DirectoryOu[] = rows.map((r) => ({
        distinguishedName: r.distinguished_name,
        name: r.name,
        parentDn: r.parent_dn,
        description: r.description,
        stale: r.stale_at !== null,
      }));
      return ouListResponseSchema.parse({ ous });
    },
  });

  // ---- GET /api/ous/contents?dn=… --------------------------------------
  // Cache-only listing of users + groups whose DN sits directly inside the
  // requested OU. "Directly" = parent DN equals `dn` case-insensitively;
  // sub-OUs are not listed here (the tree handles drill-down).
  app.get('/api/ous/contents', {
    preHandler: app.requireCapability('read:user'),
    handler: async (req): Promise<OuContentsResponse> => {
      const q = dnQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);

      // Verify the DN belongs to a known OU for this provider before
      // querying the cache tables. Without this check, a caller could pass
      // any DN suffix as `dn` and scan users by an arbitrary tail.
      const ou = await app.db
        .selectFrom('directory_ous')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null)
        .where(sql<string>`lower(distinguished_name)`, '=', q.dn.toLowerCase())
        .select('distinguished_name')
        .executeTakeFirst();
      if (!ou) {
        return ouContentsResponseSchema.parse({
          users: [],
          groups: [],
          computers: [],
          linkedGroupPolicies: [],
          inheritedGroupPolicies: [],
        });
      }

      // Suffix-match in SQL (cheap, indexable as a trigram if needed; small
      // enough to scan otherwise), then filter for *direct* children in TS
      // using the same DN parser the provider uses. This avoids fragile SQL
      // for the comma-counting and handles escaped-comma edge cases the same
      // way `parentDn` does on the provider side.
      const ouDnLc = q.dn.toLowerCase();
      const suffix = `,${q.dn}`;
      const likePattern = `%${escapeLike(suffix)}`;
      const likePatternLc = likePattern.toLowerCase();

      // Build the ancestor DN chain (selected OU's parent, grandparent, …)
      // up to the domain root. gPLink can sit on any of these; the closest
      // ancestor wins precedence-wise but we surface the whole chain so the
      // operator can see where each inherited link was applied.
      const ancestors: string[] = [];
      {
        let p = parentDn(q.dn);
        while (p) {
          ancestors.push(p);
          p = parentDn(p);
        }
      }
      const ancestorDnsLc = ancestors.map((a) => a.toLowerCase());

      const [usersAll, groupsAll, computersAll, linkedRows, inheritedRows] = await Promise.all([
        app.db
          .selectFrom('user_cache_records')
          .where('provider_id', '=', provider.id)
          .where('deleted_at', 'is', null)
          .where(sql<string>`lower(distinguished_name)`, 'like', likePatternLc)
          .select([
            'object_guid as id',
            'distinguished_name',
            'sam_account_name',
            'display_name',
            'email',
            'enabled',
            'locked',
          ])
          .orderBy('display_name', 'asc')
          .limit(2000)
          .execute(),
        app.db
          .selectFrom('group_cache_records')
          .where('provider_id', '=', provider.id)
          .where('deleted_at', 'is', null)
          .where(sql<string>`lower(distinguished_name)`, 'like', likePatternLc)
          .select([
            'object_guid as id',
            'distinguished_name',
            'name',
            'sam_account_name',
            'description',
          ])
          .orderBy('name', 'asc')
          .limit(2000)
          .execute(),
        app.db
          .selectFrom('computer_cache_records')
          .where('provider_id', '=', provider.id)
          .where('deleted_at', 'is', null)
          .where(sql<string>`lower(distinguished_name)`, 'like', likePatternLc)
          .select([
            'object_guid as id',
            'distinguished_name',
            'name',
            'sam_account_name',
            'dns_host_name',
            'operating_system',
            'enabled',
          ])
          .orderBy('name', 'asc')
          .limit(2000)
          .execute(),
        app.db
          .selectFrom('directory_group_policy_links as l')
          .innerJoin('directory_group_policies as g', (j) =>
            j.onRef('g.gpo_guid', '=', 'l.gpo_guid').onRef('g.provider_id', '=', 'l.provider_id'),
          )
          .where('l.provider_id', '=', provider.id)
          .where('g.deleted_at', 'is', null)
          .where(sql<string>`lower(l.scope_dn)`, '=', ouDnLc)
          .select([
            'g.object_guid as id',
            'l.gpo_guid',
            'g.display_name',
            'l.enabled',
            'l.enforced',
            'l.link_order',
            'l.scope_dn',
          ])
          .orderBy('l.link_order', 'asc')
          .execute(),
        ancestorDnsLc.length === 0
          ? Promise.resolve([])
          : app.db
              .selectFrom('directory_group_policy_links as l')
              .innerJoin('directory_group_policies as g', (j) =>
                j
                  .onRef('g.gpo_guid', '=', 'l.gpo_guid')
                  .onRef('g.provider_id', '=', 'l.provider_id'),
              )
              .where('l.provider_id', '=', provider.id)
              .where('g.deleted_at', 'is', null)
              .where(sql<string>`lower(l.scope_dn)`, 'in', ancestorDnsLc)
              .select([
                'g.object_guid as id',
                'l.gpo_guid',
                'g.display_name',
                'l.enabled',
                'l.enforced',
                'l.link_order',
                'l.scope_dn',
              ])
              .execute(),
      ]);

      const isDirectChild = (dn: string): boolean => {
        const parent = parentDn(dn);
        return parent !== null && parent.toLowerCase() === ouDnLc;
      };
      const users = usersAll.filter((u) => isDirectChild(u.distinguished_name)).slice(0, 500);
      const groups = groupsAll.filter((g) => isDirectChild(g.distinguished_name)).slice(0, 500);
      const computers = computersAll
        .filter((c) => isDirectChild(c.distinguished_name))
        .slice(0, 500);

      // Sort inherited links by ancestor proximity (closest first), then by
      // link_order within each scope. Closer ancestors are higher in the
      // `ancestors` array.
      const ancestorOrder = new Map<string, number>();
      ancestors.forEach((a, idx) => ancestorOrder.set(a.toLowerCase(), idx));
      const inheritedSorted = [...inheritedRows].sort((a, b) => {
        const aIdx = ancestorOrder.get(a.scope_dn.toLowerCase()) ?? 1e9;
        const bIdx = ancestorOrder.get(b.scope_dn.toLowerCase()) ?? 1e9;
        if (aIdx !== bIdx) return aIdx - bIdx;
        return a.link_order - b.link_order;
      });

      const toScopeName = (dn: string): string | null => {
        const head = leafRdn(dn);
        const eq = head.indexOf('=');
        return eq >= 0 ? head.slice(eq + 1).trim() || null : null;
      };

      const result: OuContentsResponse = {
        users: users.map((u) => ({
          id: u.id,
          samAccountName: u.sam_account_name ?? '',
          displayName: u.display_name,
          email: u.email,
          enabled: u.enabled,
          locked: u.locked,
        })),
        groups: groups.map((g) => ({
          id: g.id,
          name: g.name,
          samAccountName: g.sam_account_name,
          description: g.description,
        })),
        computers: computers.map((c) => ({
          id: c.id,
          name: c.name,
          samAccountName: c.sam_account_name,
          dnsHostName: c.dns_host_name,
          operatingSystem: c.operating_system,
          enabled: c.enabled,
        })),
        linkedGroupPolicies: linkedRows.map((r) => ({
          id: r.id,
          gpoGuid: r.gpo_guid,
          displayName: r.display_name,
          enabled: r.enabled,
          enforced: r.enforced,
          order: r.link_order,
          scopeDn: r.scope_dn,
          scopeName: toScopeName(r.scope_dn),
        })),
        inheritedGroupPolicies: inheritedSorted.map((r) => ({
          id: r.id,
          gpoGuid: r.gpo_guid,
          displayName: r.display_name,
          enabled: r.enabled,
          enforced: r.enforced,
          order: r.link_order,
          scopeDn: r.scope_dn,
          scopeName: toScopeName(r.scope_dn),
        })),
      };

      return ouContentsResponseSchema.parse(result);
    },
  });

  // ---- POST /api/ous (create a child OU) -------------------------------
  app.post('/api/ous', {
    preHandler: [app.requireCapability('write:ou.create'), app.requireStepUp],
    handler: async (req) => {
      const body = ouCreateRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      // Verify the parent OU exists in our cache for this provider. AD
      // would also reject an unknown parent, but checking here gives a
      // cleaner 400 with the actual reason.
      const parent = await app.db
        .selectFrom('directory_ous')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null)
        .where(sql<string>`lower(distinguished_name)`, '=', body.parentDn.toLowerCase())
        .select(['distinguished_name'])
        .executeTakeFirst();
      if (!parent) {
        throw app.httpErrors.badRequest('parent OU not found in directory cache');
      }

      const trimmedName = body.name.trim();
      const trimmedDescription = body.description?.trim() || null;

      // Pre-check for conflict in the cache. Doesn't rule out an entry that
      // was created in AD outside our sync window — the provider still
      // surfaces `policy_violation` from `entryAlreadyExists` as a 409.
      const candidateDn = `OU=${trimmedName},${parent.distinguished_name}`;
      const collision = await app.db
        .selectFrom('directory_ous')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null)
        .where(sql<string>`lower(distinguished_name)`, '=', candidateDn.toLowerCase())
        .select(['distinguished_name'])
        .executeTakeFirst();
      if (collision) {
        throw app.httpErrors.conflict('an OU with that name already exists at that location');
      }

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'ou.create',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'ou',
          targetDn: candidateDn,
          metadata: {
            parentDn: parent.distinguished_name,
            name: trimmedName,
            ...(trimmedDescription ? { description: trimmedDescription } : {}),
          },
        },
        async () => {
          const r = await provider.createOu(
            parent.distinguished_name,
            trimmedName,
            trimmedDescription,
            ctxFromActor(actor, req),
          );
          return {
            ok: r.ok,
            before: r.before ?? null,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
            ou: r.ou ?? null,
          };
        },
      );

      if (!result.ok) {
        if (result.errorCode === 'permission_denied') {
          throw app.httpErrors.forbidden('directory rejected the create');
        }
        if (result.errorCode === 'policy_violation') {
          throw app.httpErrors.conflict('AD rejected the create (already exists or policy)');
        }
        throw app.httpErrors.badGateway(`create failed: ${result.errorCode ?? 'unknown'}`);
      }

      // Insert into the cache so the tree picks it up immediately. Match the
      // shape the worker writes during sync.
      const ou = result.ou;
      if (!ou) {
        // Should be unreachable when result.ok is true, but the provider's
        // return type says ou is optional — guard so the rest of the
        // handler can treat it as required.
        throw app.httpErrors.badGateway('provider returned no OU after create');
      }
      const now = new Date().toISOString();
      await app.db
        .insertInto('directory_ous')
        .values({
          provider_id: provider.id,
          distinguished_name: ou.distinguishedName,
          name: ou.name,
          parent_dn: ou.parentDn,
          synced_at: now,
          stale_at: null,
          deleted_at: null,
          raw_attributes_json: stringifyForJsonb(ou.rawAttributes),
        })
        // The unique index is functional (lower(distinguished_name)), which
        // Kysely's typed `onConflict.columns` chain can't reference. Use
        // `onConflictDoNothing()` via a raw expression — if the row was
        // inserted concurrently by sync we'd rather keep the synced copy.
        .onConflict((oc) => oc.doNothing())
        .execute();

      return {
        ok: true,
        ou: {
          distinguishedName: ou.distinguishedName,
          name: ou.name,
          parentDn: ou.parentDn,
          description: trimmedDescription,
          stale: false,
        },
      };
    },
  });

  // ---- PATCH /api/ous (update mutable OU attributes) -------------------
  // Body: { dn, patch }. The only field today is `description`; null clears
  // it, a string replaces. Rename is deliberately not exposed here.
  app.patch('/api/ous', {
    preHandler: [app.requireCapability('write:ou.update'), app.requireStepUp],
    handler: async (req) => {
      const body = ouUpdateRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      const target = await app.db
        .selectFrom('directory_ous')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null)
        .where(sql<string>`lower(distinguished_name)`, '=', body.dn.toLowerCase())
        .select(['distinguished_name', 'name'])
        .executeTakeFirst();
      if (!target) {
        throw app.httpErrors.notFound('OU not found in directory cache');
      }

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'ou.update',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'ou',
          targetDn: target.distinguished_name,
          metadata: { fields: Object.keys(body.patch) },
        },
        async () => {
          const r = await provider.updateOuAttributes(
            target.distinguished_name,
            body.patch,
            ctxFromActor(actor, req),
          );
          return {
            ok: r.ok,
            before: r.before ?? null,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
          };
        },
      );

      if (!result.ok) {
        if (result.errorCode === 'permission_denied') {
          throw app.httpErrors.forbidden('directory rejected the update');
        }
        throw app.httpErrors.badGateway(`update failed: ${result.errorCode ?? 'unknown'}`);
      }

      // Update the cached raw_attributes_json so the next GET /api/ous
      // shows the new description without waiting for a sync. We mutate
      // the JSONB in place via jsonb_set / `- 'description'`.
      if ('description' in body.patch) {
        const desc = body.patch.description;
        if (desc === null || (typeof desc === 'string' && desc.trim() === '')) {
          await sql`
            UPDATE directory_ous
            SET raw_attributes_json = raw_attributes_json - 'description'
            WHERE provider_id = ${provider.id}
              AND lower(distinguished_name) = ${target.distinguished_name.toLowerCase()}
          `.execute(app.db);
        } else {
          const nextDesc = desc!.trim();
          await sql`
            UPDATE directory_ous
            SET raw_attributes_json = jsonb_set(raw_attributes_json, '{description}', to_jsonb(${nextDesc}::text))
            WHERE provider_id = ${provider.id}
              AND lower(distinguished_name) = ${target.distinguished_name.toLowerCase()}
          `.execute(app.db);
        }
      }

      return { ok: true, before: result.before, after: result.after };
    },
  });

  // ---- DELETE /api/ous (remove an empty OU) ----------------------------
  app.delete('/api/ous', {
    preHandler: [app.requireCapability('write:ou.delete'), app.requireStepUp],
    handler: async (req) => {
      const body = ouDeleteRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      // The OU must exist in the cache. If a stale client tries to delete
      // something that isn't there, surface a clean 404 rather than a
      // generic AD error.
      const target = await app.db
        .selectFrom('directory_ous')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null)
        .where(sql<string>`lower(distinguished_name)`, '=', body.dn.toLowerCase())
        .select(['distinguished_name', 'name'])
        .executeTakeFirst();
      if (!target) {
        throw app.httpErrors.notFound('OU not found in directory cache');
      }

      // Refuse if anything still lives under this OU. AD also enforces this
      // (LDAP_NOT_ALLOWED_ON_NONLEAF), but pre-checking gives the operator
      // a useful "contains N users, M groups, K sub-OUs" message.
      const counts = await countDirectChildren(app, provider.id, target.distinguished_name);
      if (counts.users + counts.groups + counts.ous > 0) {
        throw app.httpErrors.conflict(
          `OU is not empty: ${counts.users} user(s), ${counts.groups} group(s), ${counts.ous} sub-OU(s)`,
        );
      }

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'ou.delete',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'ou',
          targetDn: target.distinguished_name,
          metadata: { name: target.name },
        },
        async () => {
          const r = await provider.deleteOu(target.distinguished_name, ctxFromActor(actor, req));
          return {
            ok: r.ok,
            before: r.before ?? null,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
          };
        },
      );

      if (!result.ok) {
        if (result.errorCode === 'permission_denied') {
          throw app.httpErrors.forbidden('directory rejected the delete');
        }
        if (result.errorCode === 'policy_violation') {
          // AD's most common policy_violation here is the "Protected from
          // accidental deletion" flag. Flag it for the operator so they
          // know what to do (uncheck the flag in ADUC).
          throw app.httpErrors.conflict(
            'AD rejected the delete — the OU may be protected from accidental deletion',
          );
        }
        throw app.httpErrors.badGateway(`delete failed: ${result.errorCode ?? 'unknown'}`);
      }

      // Soft-delete the cache row so the tree refreshes on next /api/ous
      // call without waiting for a sync. The list query already filters
      // `deleted_at IS NULL`.
      await app.db
        .updateTable('directory_ous')
        .set({ deleted_at: new Date().toISOString() })
        .where('provider_id', '=', provider.id)
        .where(sql<string>`lower(distinguished_name)`, '=', target.distinguished_name.toLowerCase())
        .execute();

      return { ok: true };
    },
  });

  // Re-export the schema reference so the unused-import lint doesn't strip it.
  void directoryOuSchema;
}

/**
 * Count direct children of an OU in the cache. "Direct" means parent DN
 * equals the OU's DN (case-insensitive). Used by the delete route to refuse
 * non-empty OUs before issuing the AD modify.
 */
async function countDirectChildren(
  app: import('fastify').FastifyInstance,
  providerId: number,
  ouDn: string,
): Promise<{ users: number; groups: number; ous: number }> {
  const ouDnLc = ouDn.toLowerCase();
  const suffix = `,${ouDn}`.toLowerCase();
  const likePattern = `%${escapeLike(suffix)}`;

  // Sub-OUs we know exactly via the parent_dn column.
  const ous = await app.db
    .selectFrom('directory_ous')
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<string>`lower(parent_dn)`, '=', ouDnLc)
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .executeTakeFirst();

  // Users/groups: SQL suffix-match then filter to parent equality in TS,
  // matching the same approach the contents route uses.
  const userRows = await app.db
    .selectFrom('user_cache_records')
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<string>`lower(distinguished_name)`, 'like', likePattern)
    .select(['distinguished_name'])
    .limit(50)
    .execute();
  const groupRows = await app.db
    .selectFrom('group_cache_records')
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<string>`lower(distinguished_name)`, 'like', likePattern)
    .select(['distinguished_name'])
    .limit(50)
    .execute();

  const isDirect = (dn: string): boolean => {
    const parent = parentDn(dn);
    return parent !== null && parent.toLowerCase() === ouDnLc;
  };

  return {
    ous: Number(ous?.c ?? 0),
    users: userRows.filter((r) => isDirect(r.distinguished_name)).length,
    groups: groupRows.filter((r) => isDirect(r.distinguished_name)).length,
  };
}

/**
 * Build the WriteContext the provider expects from the request actor and
 * the cached step-up password. Mirrors the helper in routes/users.ts.
 */
function ctxFromActor(
  actor: NonNullable<import('fastify').FastifyRequest['actor']>,
  req: import('fastify').FastifyRequest,
): { actorUserId: string; actorUsername: string; actorPassword: string; correlationId: string } {
  return {
    actorUserId: actor.session.actorUserId,
    actorUsername: actor.session.actorUsername!,
    actorPassword: actor.elevatedPassword!,
    correlationId: req.correlationId,
  };
}

/** Escape SQL LIKE wildcards in a literal value. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
