// SPDX-License-Identifier: BUSL-1.1
// AD Recycle Bin / tombstone routes.
//
// Endpoints:
//   GET  /api/deleted-users           list deleted users (paginated, search)
//   GET  /api/deleted-users/:guid     single deleted user (full attrs preserved by AD)
//   POST /api/deleted-users/:guid/restore  reanimate (write:user.restore)
//
// All endpoints query the directory live — there's no cache. Deleted-user
// listings change rarely, the dataset is small, and accuracy matters more
// than latency for restore decisions (operators need to see the most recent
// state, not a stale snapshot).
//
// All three endpoints require step-up. The provider methods bind as the
// operator (not the service account) so AD's own ACLs decide who sees
// what — a Helpdesk-tier admin lacking read on Deleted Objects will see
// an empty list, and lacking the Reanimate Tombstones extended right
// will get a 403 on restore. Step-up is what makes the operator's bind
// password available in the credential cache.
//
// The list response embeds the recycle-bin status so the UI banner doesn't
// need a second round-trip.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  deletedUserDetailSchema,
  deletedUserSearchQuerySchema,
  deletedUserSearchResponseSchema,
  recycleBinStatusSchema,
  restoreUserRequestSchema,
  type DeletedUserDetail,
  type DeletedUserSearchResponse,
  type RestoreUserResponse,
} from '@openaduc/shared';
import { StepUpBindFailedError, type WriteContext } from '../providers/types.js';
import { NotFound, StepUpRequired, Unauthorized } from '../plugins/errorHandler.js';
import { auditContextFromRequest, withAudit } from '../services/auditContext.js';

const guidParamSchema = z.object({ guid: z.string().uuid() });

/**
 * Build the operator WriteContext from the authenticated request. The
 * non-null assertions are safe because requireStepUp gates every handler
 * that calls this — without an elevated session + cached password we
 * never reach the body.
 */
function ctxFromReq(req: FastifyRequest): WriteContext {
  const actor = req.actor!;
  return {
    actorUserId: actor.session.actorUserId,
    actorUsername: actor.session.actorUsername!,
    actorPassword: actor.elevatedPassword!,
    correlationId: req.correlationId,
  };
}

export async function registerDeletedUserRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/deleted-users ------------------------------------------
  app.get('/api/deleted-users', {
    preHandler: [app.requireCapability('read:user.deleted'), app.requireStepUp],
    handler: async (req): Promise<DeletedUserSearchResponse> => {
      const q = deletedUserSearchQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);
      const ctx = ctxFromReq(req);
      if (!req.actor!.session.actorUsername) {
        throw Unauthorized('session has no bind identity');
      }

      let status, all;
      try {
        [status, all] = await Promise.all([
          provider.getRecycleBinStatus(ctx),
          provider.searchDeletedUsers(q.q ? { text: q.q } : {}, ctx),
        ]);
      } catch (err) {
        if (err instanceof StepUpBindFailedError) {
          // Cached step-up password is stale (operator's AD password
          // changed, or the credential was wiped). 403 prompts the UI
          // to drop edit mode and ask for re-elevation.
          throw StepUpRequired(
            'the directory rejected your editing session — please re-authenticate',
          );
        }
        throw err;
      }

      // Stable ordering: most-recently-deleted first, then by display name.
      // Pagination happens client-side from the in-memory list — the dataset
      // is small (operators rarely accumulate thousands of pending-restore
      // entries) and the LDAP search already returned everything matching.
      all.sort((a, b) => {
        const at = a.deletedAt?.getTime() ?? 0;
        const bt = b.deletedAt?.getTime() ?? 0;
        if (bt !== at) return bt - at;
        const an = (a.displayName ?? a.cn ?? '').toLowerCase();
        const bn = (b.displayName ?? b.cn ?? '').toLowerCase();
        return an.localeCompare(bn);
      });

      const total = all.length;
      const start = (q.page - 1) * q.pageSize;
      const slice = all.slice(start, start + q.pageSize);

      const result: DeletedUserSearchResponse = {
        rows: slice.map((u) => ({
          id: u.objectGuid,
          cn: u.cn,
          samAccountName: u.samAccountName,
          userPrincipalName: u.userPrincipalName,
          displayName: u.displayName,
          email: u.email,
          deletedDn: u.deletedDn,
          lastKnownParent: u.lastKnownParent,
          deletedAt: u.deletedAt ? u.deletedAt.toISOString() : null,
          recycled: u.recycled,
        })),
        total,
        page: q.page,
        pageSize: q.pageSize,
        recycleBin: recycleBinStatusSchema.parse(status),
      };
      return deletedUserSearchResponseSchema.parse(result);
    },
  });

  // ---- GET /api/deleted-users/:guid ------------------------------------
  app.get('/api/deleted-users/:guid', {
    preHandler: [app.requireCapability('read:user.deleted'), app.requireStepUp],
    handler: async (req): Promise<{ user: DeletedUserDetail }> => {
      const { guid } = guidParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);
      if (!req.actor!.session.actorUsername) {
        throw Unauthorized('session has no bind identity');
      }
      let user;
      try {
        user = await provider.getDeletedUser(guid, ctxFromReq(req));
      } catch (err) {
        if (err instanceof StepUpBindFailedError) {
          throw StepUpRequired(
            'the directory rejected your editing session — please re-authenticate',
          );
        }
        throw err;
      }
      if (!user) throw NotFound('deleted user not found');
      const detail: DeletedUserDetail = {
        id: user.objectGuid,
        cn: user.cn,
        samAccountName: user.samAccountName,
        userPrincipalName: user.userPrincipalName,
        displayName: user.displayName,
        email: user.email,
        deletedDn: user.deletedDn,
        lastKnownParent: user.lastKnownParent,
        deletedAt: user.deletedAt ? user.deletedAt.toISOString() : null,
        recycled: user.recycled,
        rawAttributes: user.rawAttributes,
      };
      return { user: deletedUserDetailSchema.parse(detail) };
    },
  });

  // ---- POST /api/deleted-users/:guid/restore ---------------------------
  app.post('/api/deleted-users/:guid/restore', {
    preHandler: [app.requireCapability('write:user.restore'), app.requireStepUp],
    handler: async (req): Promise<RestoreUserResponse> => {
      const { guid } = guidParamSchema.parse(req.params);
      const body = restoreUserRequestSchema.parse(req.body ?? {});
      if (!req.actor!.session.actorUsername) {
        throw Unauthorized('session has no bind identity');
      }
      const provider = await app.services.providers.buildForRequest(req);
      const ctx = ctxFromReq(req);

      // Pre-write read so the audit row carries the deleted-state snapshot.
      // If the entry isn't there we 404 before touching AD writes.
      let before;
      try {
        before = await provider.getDeletedUser(guid, ctx);
      } catch (err) {
        if (err instanceof StepUpBindFailedError) {
          throw StepUpRequired(
            'the directory rejected your editing session — please re-authenticate',
          );
        }
        throw err;
      }
      if (!before) throw NotFound('deleted user not found');

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.restore',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          targetId: before.objectGuid,
          targetDn: before.deletedDn,
          metadata: {
            lastKnownParent: before.lastKnownParent,
            // Record the operator's parent override (if any) at the route
            // layer so the audit row reflects intent even when AD ends up
            // honoring lastKnownParent because the override matched.
            targetParentDn: body.targetParentDn ?? null,
          },
        },
        async () => {
          const r = await provider.restoreDeletedUser(
            before!.objectGuid,
            { ...(body.targetParentDn ? { targetParentDn: body.targetParentDn } : {}) },
            ctx,
          );
          return {
            ok: r.ok,
            before: r.before ?? null,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
            // Threaded out so the handler can return them to the client.
            restoredDn: r.restoredDn,
            errorMessage: r.errorMessage ?? null,
          };
        },
      );

      if (!result.ok) {
        // Surface the underlying LDAP error message — operators debugging
        // a failed restore need to see what AD actually said (missing
        // parent OU, no extended right, schema rejection, etc.). The
        // generic `${errorCode}` was too opaque ("directory_error" tells
        // you nothing).
        const detail = result.errorMessage ? `: ${result.errorMessage}` : '';
        if (result.errorCode === 'permission_denied') {
          throw app.httpErrors.forbidden(
            `restore rejected — your account may be missing the Reanimate Tombstones extended right${detail}`,
          );
        }
        if (result.errorCode === 'policy_violation') {
          throw app.httpErrors.conflict(`restore rejected by directory policy${detail}`);
        }
        if (result.errorCode === 'not_found') {
          throw app.httpErrors.notFound('deleted user not found');
        }
        throw app.httpErrors.badGateway(
          `restore failed (${result.errorCode ?? 'unknown'})${detail}`,
        );
      }

      // Trigger a cache refresh on the restored DN so the user appears in
      // the live `/api/users` listing without waiting for the next sync.
      // Best-effort: if the live refresh fails (replication lag, transient
      // DC error), the next sync will fix it; we don't fail the restore.
      try {
        await app.services.userLiveRefresh.refresh(provider, before.objectGuid);
      } catch (err) {
        req.log.warn({ err, guid: before.objectGuid }, 'post-restore refresh failed');
      }

      return {
        ok: true,
        restoredDn: result.restoredDn ?? '',
      };
    },
  });
}
