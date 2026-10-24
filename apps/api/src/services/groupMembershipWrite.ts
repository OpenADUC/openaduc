// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type {
  DirectoryObjectIdentifier,
  DirectoryProvider,
  WriteContext,
} from '../providers/types.js';
import type { AuditEventInput, AuditService } from './audit.js';
import { withAudit, type WriteOpResult } from './auditContext.js';
import { reconcileNestedGroups, upsertGroup, type CachedGroup } from './groupCache.js';
import type { UserLiveRefreshService } from './userLiveRefresh.js';

export interface MembershipChange {
  kind: 'user' | 'group';
  op: 'add' | 'remove';
  member: { objectGuid: string; distinguishedName: string };
  group: Pick<CachedGroup, 'id' | 'distinguishedName' | 'name'>;
}

/**
 * Add a user or group to a group, or take it out, as the operator, and
 * audit it: `user.group.add`, `group.group.remove`, … targeting the member,
 * with the group in the metadata. The single-member routes and bulk jobs
 * both run this, so a membership changed either way is audited the same
 * way. The caller refreshes the cache afterwards (`refreshMembershipCache`).
 */
export async function writeGroupMembership(
  audit: Pick<AuditService, 'recordEvent'>,
  provider: DirectoryProvider,
  { kind, op, member, group }: MembershipChange,
  writeCtx: WriteContext,
  base: Omit<AuditEventInput, 'action' | 'result' | 'providerId' | 'targetType'>,
): Promise<WriteOpResult> {
  const memberRef: DirectoryObjectIdentifier = { kind: 'objectGuid', value: member.objectGuid };
  const groupRef: DirectoryObjectIdentifier = { kind: 'objectGuid', value: group.id };
  return withAudit(
    audit,
    {
      ...base,
      action: `${kind}.group.${op}`,
      actorAuthMethod: 'ad-password',
      providerId: provider.id,
      targetType: kind,
      targetId: member.objectGuid,
      targetDn: member.distinguishedName,
      metadata: { groupId: group.id, groupDn: group.distinguishedName, groupName: group.name },
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
}

/**
 * Show membership changes in the cache straight away rather than after the
 * next sync. A user's memberships come from its own memberOf, so one
 * refresh covers every group it joined or left; a nested group's come from
 * the parent group's member.
 */
export async function refreshMembershipCache(
  deps: {
    db: Kysely<DB>;
    userLiveRefresh: Pick<UserLiveRefreshService, 'refresh' | 'reconcileDirectMemberships'>;
  },
  provider: DirectoryProvider,
  change: { kind: 'user'; memberId: string } | { kind: 'group'; groupId: string },
): Promise<void> {
  if (change.kind === 'user') {
    const after = await deps.userLiveRefresh.refresh(provider, change.memberId);
    if (after) {
      await deps.userLiveRefresh.reconcileDirectMemberships(
        provider.id,
        change.memberId,
        after.user.memberOfDns,
      );
    }
    return;
  }
  const parent = await provider.getGroup({ kind: 'objectGuid', value: change.groupId });
  if (parent) {
    await upsertGroup(deps.db, provider.id, parent);
    await reconcileNestedGroups(deps.db, provider.id, parent.objectGuid, parent.memberDns);
  }
}
