// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  tapIssueRequestSchema,
  tapIssueResponseSchema,
  tapPreflightSchema,
  type TapIssueResponse,
  type TapPreflight,
} from '@openaduc/shared';
import { z } from 'zod';
import { AppError, NotFound } from '../plugins/errorHandler.js';
import type { DirectoryUser } from '../providers/types.js';
import { auditContextFromRequest, withAudit } from '../services/auditContext.js';
import { graphFailure } from './graphFailure.js';
import {
  issueTap,
  TapNotEnabled,
  tapPreflight,
  tapUserOf,
  type TapDeps,
  type TapIssueOutcome,
  type TapUser,
} from '../services/temporaryAccessPass.js';

// Issue TAP on a user's page. Both routes take write:user.issueTap: the
// preflight says whether this user may have one and within what limits,
// which matters only to someone who may issue it. The value is in the
// issue response alone; it's never stored, logged or audited.

const idParamSchema = z.object({ id: z.guid() });

export async function registerTemporaryAccessPassRoutes(app: FastifyInstance): Promise<void> {
  async function prepare(
    req: FastifyRequest,
  ): Promise<{ user: DirectoryUser; tapUser: TapUser; deps: TapDeps }> {
    const { id } = idParamSchema.parse(req.params);
    const directoryId = req.directoryId!;
    const graph = await app.services.graphClient.tapGraph(directoryId);
    if (!graph) throw TapNotEnabled();
    const provider = await app.services.providers.buildForRequest(req);
    const user = await provider.getUser({ kind: 'objectGuid', value: id });
    if (!user) throw NotFound('user not found');
    return {
      user,
      tapUser: tapUserOf(user),
      deps: {
        graph,
        tokenGroups: () =>
          provider.getUserTokenGroups({ kind: 'objectGuid', value: user.objectGuid }),
        roleGroups: await app.services.authorization.roleGroups(),
      },
    };
  }

  // ---- GET /api/users/:id/temporary-access-pass --------------------------
  app.get('/api/users/:id/temporary-access-pass', {
    config: {
      // Each preflight makes several Graph calls, some listing the tenant's
      // role assignments.
      rateLimit: { max: 30, timeWindow: '1 minute' },
      policy: { capability: 'write:user.issueTap', stepUp: false, directory: 'caller' },
    },
    handler: async (req): Promise<TapPreflight> => {
      const { tapUser, deps } = await prepare(req);
      const { preflight } = await tapPreflight(deps, tapUser).catch(graphFailure);
      return tapPreflightSchema.parse(preflight);
    },
  });

  // ---- POST /api/users/:id/temporary-access-pass -------------------------
  app.post('/api/users/:id/temporary-access-pass', {
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
      policy: { capability: 'write:user.issueTap', stepUp: true, directory: 'caller' },
    },
    handler: async (req, reply): Promise<TapIssueResponse> => {
      const body = tapIssueRequestSchema.parse(req.body);
      const { user, tapUser, deps } = await prepare(req);

      const { outcome } = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.tap.issue',
          actorAuthMethod: 'ad-password',
          targetType: 'user',
          targetId: user.objectGuid,
          targetDn: user.distinguishedName,
          metadata: {
            startsAt: body.startsAt,
            lifetimeMinutes: body.lifetimeMinutes,
            isUsableOnce: body.isUsableOnce,
            replaceExisting: body.replaceExisting,
          },
        },
        async () => {
          const outcome: TapIssueOutcome = await issueTap(deps, tapUser, body);
          if (!outcome.ok) {
            return { ok: false, errorCode: outcome.code, errorMessage: outcome.message, outcome };
          }
          const { temporaryAccessPass: _value, ...issued } = outcome.issued;
          return { ok: true, after: { entraUserId: outcome.entraUserId, ...issued }, outcome };
        },
      ).catch(graphFailure);

      if (!outcome.ok) {
        throw new AppError({
          statusCode: outcome.code === 'outside_policy' ? 400 : 409,
          code: outcome.code,
          message: outcome.message,
          ...(outcome.existing ? { details: { existing: outcome.existing } } : {}),
        });
      }
      reply.header('Cache-Control', 'no-store');
      return tapIssueResponseSchema.parse(outcome.issued);
    },
  });
}
