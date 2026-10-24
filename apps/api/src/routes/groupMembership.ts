// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { groupMembershipChangeSchema } from '@openaduc/shared';
import { NotFound, Unauthorized } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import { findCachedGroups } from '../services/groupCache.js';
import {
  membershipRequirement,
  refreshMembershipCache,
  writeGroupMembership,
} from '../services/groupMembershipWrite.js';
import { ctx } from './writeContext.js';

const idParamSchema = z.object({ id: z.guid() });

/**
 * Add the user or group `:id` to the group named in the body, or remove it.
 * Both POST/DELETE /api/users/:id/groups and /api/groups/:id/groups run
 * this, so a change made from the member's page or the group's checks,
 * writes and audits the same way (`writeGroupMembership`), and the cache
 * shows it straight away.
 */
export async function changeMembership(
  app: FastifyInstance,
  req: FastifyRequest,
  kind: 'user' | 'group',
  op: 'add' | 'remove',
): Promise<{ ok: true; before: unknown; after: unknown }> {
  const { id } = idParamSchema.parse(req.params);
  const body = groupMembershipChangeSchema.parse(req.body);
  if (kind === 'group' && body.groupId.toLowerCase() === id.toLowerCase()) {
    throw app.httpErrors.badRequest('a group can’t be a member of itself');
  }
  const actor = req.actor!;
  if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
  const provider = await app.services.providers.buildForRequest(req);
  const member =
    kind === 'user'
      ? (await app.services.userLiveRefresh.refresh(provider, id))?.user
      : await provider.getGroup({ kind: 'objectGuid', value: id });
  if (!member) throw NotFound(`${kind} not found`);

  // Validate the group id belongs to this provider before bothering AD.
  const [group] = await findCachedGroups(app.db, provider.id, { ids: [body.groupId] });
  if (!group) throw NotFound('group not found');
  const needs = membershipRequirement(op, [group], await app.services.authorization.roleGroups());
  if (needs) await app.requireCapability(req, needs.capability, needs.reason);

  const result = await writeGroupMembership(
    app.services.audit,
    provider,
    { kind, op, member, group },
    ctx(actor, req),
    auditContextFromRequest(req),
  );

  if (!result.ok) {
    const detail = result.errorMessage ? `: ${result.errorMessage}` : '';
    switch (result.errorCode) {
      case 'permission_denied':
        throw app.httpErrors.forbidden(`directory rejected the change${detail}`);
      case 'not_found':
        throw app.httpErrors.notFound(`${kind} or group not found in directory`);
      case 'conflict':
        throw app.httpErrors.conflict(`directory rejected the change${detail}`);
      case 'policy_violation':
        throw app.httpErrors.unprocessableEntity(`directory refused the change${detail}`);
      default:
        throw app.httpErrors.badGateway(`group ${op} failed${detail}`);
    }
  }

  await refreshMembershipCache(
    { db: app.db, userLiveRefresh: app.services.userLiveRefresh },
    provider,
    kind === 'user' ? { kind, memberId: id } : { kind, groupId: body.groupId },
  );
  return { ok: true, before: result.before, after: result.after };
}
