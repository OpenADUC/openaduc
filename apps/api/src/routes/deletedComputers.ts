// SPDX-License-Identifier: BUSL-1.1
// AD Recycle Bin / tombstone routes for computers.
//
// Endpoints:
//   GET  /api/deleted-computers           list deleted computers
//   GET  /api/deleted-computers/:guid     single deleted computer
//
// Same operator-bind / step-up gate as deletedUsers — we deliberately do NOT
// cache tombstoned computers. The list is queried live each time the
// operator opens the page (the dataset is small and accuracy matters more
// than latency here).
//
// v1 does not expose a restore primitive for computers. The provider could
// support it the same way `restoreDeletedUser` works, but the operational
// case is rare; if the need comes up we can add `POST /:guid/restore` later
// alongside `write:computer.restore`.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  deletedComputerDetailSchema,
  deletedComputerSearchQuerySchema,
  deletedComputerSearchResponseSchema,
  type DeletedComputerDetail,
  type DeletedComputerSearchResponse,
} from '@openaduc/shared';
import { StepUpBindFailedError, type WriteContext } from '../providers/types.js';
import { NotFound, StepUpRequired, Unauthorized } from '../plugins/errorHandler.js';

const guidParamSchema = z.object({ guid: z.string().uuid() });

function ctxFromReq(req: FastifyRequest): WriteContext {
  const actor = req.actor!;
  return {
    actorUserId: actor.session.actorUserId,
    actorUsername: actor.session.actorUsername!,
    actorPassword: actor.elevatedPassword!,
    correlationId: req.correlationId,
  };
}

export async function registerDeletedComputerRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/deleted-computers --------------------------------------
  app.get('/api/deleted-computers', {
    preHandler: [app.requireCapability('read:computer.deleted'), app.requireStepUp],
    handler: async (req): Promise<DeletedComputerSearchResponse> => {
      const q = deletedComputerSearchQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);
      const ctx = ctxFromReq(req);
      if (!req.actor!.session.actorUsername) {
        throw Unauthorized('session has no bind identity');
      }

      let all;
      try {
        all = await provider.searchDeletedComputers(q.q ? { text: q.q } : {}, ctx);
      } catch (err) {
        if (err instanceof StepUpBindFailedError) {
          throw StepUpRequired(
            'the directory rejected your editing session — please re-authenticate',
          );
        }
        throw err;
      }

      // Most-recently-deleted first, then by CN.
      all.sort((a, b) => {
        const at = a.deletedAt?.getTime() ?? 0;
        const bt = b.deletedAt?.getTime() ?? 0;
        if (bt !== at) return bt - at;
        const an = (a.cn ?? '').toLowerCase();
        const bn = (b.cn ?? '').toLowerCase();
        return an.localeCompare(bn);
      });

      const total = all.length;
      const start = (q.page - 1) * q.pageSize;
      const slice = all.slice(start, start + q.pageSize);

      const result: DeletedComputerSearchResponse = {
        rows: slice.map((c) => ({
          id: c.objectGuid,
          cn: c.cn,
          samAccountName: c.samAccountName,
          dnsHostName: c.dnsHostName,
          operatingSystem: c.operatingSystem,
          deletedDn: c.deletedDn,
          lastKnownParent: c.lastKnownParent,
          deletedAt: c.deletedAt ? c.deletedAt.toISOString() : null,
          recycled: c.recycled,
        })),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
      return deletedComputerSearchResponseSchema.parse(result);
    },
  });

  // ---- GET /api/deleted-computers/:guid --------------------------------
  app.get('/api/deleted-computers/:guid', {
    preHandler: [app.requireCapability('read:computer.deleted'), app.requireStepUp],
    handler: async (req): Promise<{ computer: DeletedComputerDetail }> => {
      const { guid } = guidParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);
      if (!req.actor!.session.actorUsername) {
        throw Unauthorized('session has no bind identity');
      }
      let computer;
      try {
        computer = await provider.getDeletedComputer(guid, ctxFromReq(req));
      } catch (err) {
        if (err instanceof StepUpBindFailedError) {
          throw StepUpRequired(
            'the directory rejected your editing session — please re-authenticate',
          );
        }
        throw err;
      }
      if (!computer) throw NotFound('deleted computer not found');
      const detail: DeletedComputerDetail = {
        id: computer.objectGuid,
        cn: computer.cn,
        samAccountName: computer.samAccountName,
        dnsHostName: computer.dnsHostName,
        operatingSystem: computer.operatingSystem,
        deletedDn: computer.deletedDn,
        lastKnownParent: computer.lastKnownParent,
        deletedAt: computer.deletedAt ? computer.deletedAt.toISOString() : null,
        recycled: computer.recycled,
        rawAttributes: computer.rawAttributes,
      };
      return { computer: deletedComputerDetailSchema.parse(detail) };
    },
  });
}
