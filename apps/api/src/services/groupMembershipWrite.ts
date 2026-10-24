// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { BulkMembershipOp, Capability, Role } from '@openaduc/shared';
import { grantedRole, type RoleGroup } from '../lib/groupPrivilege.js';
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

/** What refreshing the cache after a membership change needs. */
export interface MembershipCacheDeps {
  db: Kysely<DB>;
  userLiveRefresh: Pick<UserLiveRefreshService, 'refresh' | 'reconcileDirectMemberships'>;
}

/** A capability a membership change takes beyond write:group.membership, and why. */
export interface MembershipRequirement {
  capability: Capability;
  reason: string;
}

/**
 * What else adding to these groups takes. A group mapped to an OpenADUC
 * role hands that role to its members (and to members of a group nested
 * in it), which only an operator who may configure security can do.
 * Taking members out takes nothing more.
 */
export function membershipRequirement(
  op: BulkMembershipOp,
  groups: readonly { distinguishedName: string; name: string }[],
  roleGroups: readonly RoleGroup[],
): MembershipRequirement | null {
  if (op !== 'add') return null;
  for (const group of groups) {
    const role = grantedRole(group.distinguishedName, roleGroups);
    if (role) {
      return {
        capability: 'configure:security',
        reason: `Adding members to ${group.name} gives them OpenADUC’s ${ROLE_NAMES[role]} role, which takes the configure:security capability.`,
      };
    }
  }
  return null;
}

/** What a membership change takes beyond write:group.membership, as a list a job checks. */
export const membershipRequirements = (
  op: BulkMembershipOp,
  groups: readonly { distinguishedName: string; name: string }[],
  roleGroups: readonly RoleGroup[],
): MembershipRequirement[] => {
  const needs = membershipRequirement(op, groups, roleGroups);
  return needs ? [needs] : [];
};

const ROLE_NAMES: Record<Role, string> = {
  admin: 'Admin',
  operator: 'Operator',
  auditor: 'Auditor',
};

export interface MembershipChange {
  kind: 'user' | 'group';
  op: BulkMembershipOp;
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
  deps: MembershipCacheDeps,
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
