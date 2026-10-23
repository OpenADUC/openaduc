// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { groupMembershipChangeSchema } from '@openaduc/shared';
import { NotFound, Unauthorized } from '../plugins/errorHandler.js';
import type { DirectoryObjectIdentifier, WriteContext } from '../providers/types.js';
import { auditContextFromRequest, withAudit } from '../services/auditContext.js';
import { reconcileNestedGroups, upsertGroup } from '../services/groupCache.js';

const idParamSchema = z.object({ id: z.guid() });

/**
 * Add the user or group `:id` to the group named in the body, or remove it.
 * Both POST/DELETE /api/users/:id/groups and /api/groups/:id/groups run
 * this, so a change made from the member's page or the group's checks,
 * writes and audits the same way: `user.group.add`, `group.group.remove`,
 * … targeting the member, with the group in the metadata. The cache shows
 * the change straight away rather than after the next sync.
 */
export async function changeMembership(
  app: FastifyInstance,
  req: FastifyRequest,
  kind: 'user' | 'group',
  op: 'add' | 'remove',
): Promise<{ ok: true; before: unknown; after: unknown }> {
  const { id } = idParamSchema.parse(req.params);
  const body = groupMembershipChangeSchema.parse(req.body);
  if (kind === 'group' && body.groupId === id) {
    throw app.httpErrors.badRequest('a group can’t be a member of itself');
  }
  const actor = req.actor!;
  if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
  const provider = await app.services.providers.buildForRequest(req);
  const memberRef: DirectoryObjectIdentifier = { kind: 'objectGuid', value: id };
  const groupRef: DirectoryObjectIdentifier = { kind: 'objectGuid', value: body.groupId };

  const member =
    kind === 'user'
      ? (await app.services.userLiveRefresh.refresh(provider, id))?.user
      : await provider.getGroup(memberRef);
  if (!member) throw NotFound(`${kind} not found`);

  // Validate the group id belongs to this provider before bothering AD.
  const groupRow = await app.db
    .selectFrom('group_cache_records')
    .select(['object_guid', 'distinguished_name', 'name'])
    .where('provider_id', '=', provider.id)
    .where('object_guid', '=', body.groupId)
    .executeTakeFirst();
  if (!groupRow) throw NotFound('group not found');

  const writeCtx: WriteContext = {
    actorUserId: actor.session.actorUserId,
    actorUsername: actor.session.actorUsername,
    actorPassword: actor.elevatedPassword!,
    correlationId: req.correlationId,
  };
  const result = await withAudit(
    app.services.audit,
    {
      ...auditContextFromRequest(req),
      action: `${kind}.group.${op}`,
      actorAuthMethod: 'ad-password',
      providerId: provider.id,
      targetType: kind,
      targetId: member.objectGuid,
      targetDn: member.distinguishedName,
      metadata: {
        groupId: body.groupId,
        groupDn: groupRow.distinguished_name,
        groupName: groupRow.name,
      },
    },
    async () => {
      const r = await (kind === 'user'
        ? op === 'add'
          ? provider.addUserToGroup(memberRef, groupRef, writeCtx)
          : provider.removeUserFromGroup(memberRef, groupRef, writeCtx)
        : op === 'add'
          ? provider.addGroupToGroup(memberRef, groupRef, writeCtx)
          : provider.removeGroupFromGroup(memberRef, groupRef, writeCtx));
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

  // A user's memberships come from its own memberOf; a nested group's from
  // the parent group's member.
  if (kind === 'user') {
    const after = await app.services.userLiveRefresh.refresh(provider, id);
    if (after) {
      await app.services.userLiveRefresh.reconcileDirectMemberships(
        provider.id,
        id,
        after.user.memberOfDns,
      );
    }
  } else {
    const parent = await provider.getGroup(groupRef);
    if (parent) {
      await upsertGroup(app.db, provider.id, parent);
      await reconcileNestedGroups(app.db, provider.id, parent.objectGuid, parent.memberDns);
    }
  }
  return { ok: true, before: result.before, after: result.after };
}
