// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFound, Unauthorized } from '../plugins/errorHandler.js';
import type {
  DirectoryObjectIdentifier,
  DirectoryProvider,
  MutationResult,
  WriteContext,
} from '../providers/types.js';
import { computerWriteBlock, describeComputerWriteBlock } from '../lib/computerWrites.js';
import { auditContextFromRequest, withAudit } from '../services/auditContext.js';
import { directoryRefusal } from './directoryRefusal.js';
import { ctx } from './writeContext.js';

const idParamSchema = z.object({ id: z.guid() });

/**
 * One audited write to the computer `:id`, as the operator, with the cache
 * updated before and after. With `refuseProtected`, a domain controller or
 * critical system object is refused with 409 and audited as a failure with
 * the reason; the provider repeats the check on its own bind.
 */
export async function writeComputer(
  app: FastifyInstance,
  req: FastifyRequest,
  provider: DirectoryProvider,
  spec: {
    action: string;
    /** What was refused, as in "cannot disable". */
    verb: string;
    refuseProtected: boolean;
    forbidden?: string;
    metadata?: Record<string, unknown>;
    write: (
      provider: DirectoryProvider,
      id: DirectoryObjectIdentifier,
      writeCtx: WriteContext,
    ) => Promise<MutationResult>;
  },
): Promise<{ ok: true; before: unknown; after: unknown }> {
  const { id } = idParamSchema.parse(req.params);
  const actor = req.actor!;
  if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');

  const before = await app.services.computerLiveRefresh.refresh(provider, id);
  if (!before) throw NotFound('computer not found');
  const block = spec.refuseProtected ? computerWriteBlock(before.rawAttributes) : null;
  const metadata = { ...spec.metadata, ...(block ? { blockedReason: block } : {}) };

  const result = await withAudit(
    app.services.audit,
    {
      ...auditContextFromRequest(req),
      action: spec.action,
      actorAuthMethod: 'ad-password',
      providerId: provider.id,
      targetType: 'computer',
      targetId: before.objectGuid,
      targetDn: before.distinguishedName,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
    async () => {
      if (block) {
        return {
          ok: false,
          errorCode: 'policy_violation',
          errorMessage: describeComputerWriteBlock(block),
        };
      }
      const r = await spec.write(provider, { kind: 'objectGuid', value: id }, ctx(actor, req));
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
      verb: spec.verb,
      notFound: 'computer not found',
      ...(spec.forbidden ? { forbidden: spec.forbidden } : {}),
    });
  }

  await app.services.computerLiveRefresh.refresh(provider, id);
  return { ok: true, before: result.before, after: result.after };
}
