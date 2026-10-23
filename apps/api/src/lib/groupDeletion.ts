// SPDX-License-Identifier: BUSL-1.1
import type { GroupDeleteBlockReason, Role } from '@openaduc/shared';
import { GROUP_TYPE } from '../providers/active-directory/normalize.js';
import { rawFlag, rawScalarValue } from './rawAttributes.js';
import { ridOf } from './sid.js';

export interface GroupLike {
  distinguishedName: string;
  sid: string | null;
  rawAttributes: Record<string, unknown>;
}

/** What else, beyond the group's own entry, decides whether it may go. */
export interface GroupDeleteFacts {
  /** The groups it is directly a member of, read from AD. */
  parents: readonly GroupLike[];
  /** Accounts whose primary group it is; null when AD couldn't be asked. */
  primaryGroupMembers: number | null;
}

export interface RoleGroup {
  dn: string;
  role: Role;
}

export interface GroupDeleteBlock {
  reason: GroupDeleteBlockReason;
  /** For role_group: the role the group grants. */
  role?: Role;
  /** For member_of_protected_group: the protected parents. */
  parents?: GroupLike[];
  /** For primary_group: how many accounts. */
  primaryGroupMembers?: number;
}

// Domain Admins (512), Domain Users (513), Cert Publishers (517), … and
// every group in the Builtin domain (S-1-5-32-5xx) have RIDs below 1000.
const FIRST_NON_BUILTIN_RID = 1000;

// The groups AdminSDHolder protects, by well-known SID rather than name
// (names are localized and can be changed): in the Builtin domain
// Administrators, Account/Server/Print/Backup Operators and Replicator; in
// the domain Domain Admins, Domain Controllers, Schema Admins, Enterprise
// Admins, Read-only Domain Controllers, Key Admins, Enterprise Key Admins.
// DnsAdmins and DnsUpdateProxy have no well-known RID, so only their
// adminCount can mark them.
const PROTECTED_BUILTIN_RIDS = new Set([544, 548, 549, 550, 551, 552]);
const PROTECTED_DOMAIN_RIDS = new Set([512, 516, 518, 519, 521, 526, 527]);

/** True for a group AdminSDHolder protects, or has flagged with adminCount=1. */
export function isProtectedGroup(group: GroupLike): boolean {
  if (rawScalarValue(group.rawAttributes['adminCount']) === '1') return true;
  const rid = ridOf(group.sid);
  if (rid === null) return false;
  return group.sid!.startsWith('S-1-5-32-')
    ? PROTECTED_BUILTIN_RIDS.has(rid)
    : PROTECTED_DOMAIN_RIDS.has(rid);
}

/**
 * Why this group must not be deleted, or null when it may be. Shared by
 * the preflight, the route and the provider (reading the live entry right
 * before the delete).
 */
export function groupDeleteBlock(
  group: GroupLike,
  facts: GroupDeleteFacts,
  roleGroups: readonly RoleGroup[],
): GroupDeleteBlock | null {
  const raw = group.rawAttributes;
  if (rawFlag(raw['isCriticalSystemObject'])) return { reason: 'critical_system_object' };
  const groupType = Number.parseInt(rawScalarValue(raw['groupType']) ?? '', 10);
  const rid = ridOf(group.sid);
  if (
    /,CN=Builtin,/i.test(group.distinguishedName) ||
    (Number.isFinite(groupType) && (groupType & GROUP_TYPE.builtin) !== 0) ||
    (rid !== null && rid < FIRST_NON_BUILTIN_RID)
  ) {
    return { reason: 'builtin_group' };
  }
  if (isProtectedGroup(group)) return { reason: 'protected_group' };
  const dn = group.distinguishedName.toLowerCase();
  const mapped = roleGroups.find((g) => g.dn.toLowerCase() === dn);
  if (mapped) return { reason: 'role_group', role: mapped.role };
  const protectedParents = facts.parents.filter(isProtectedGroup);
  if (protectedParents.length > 0) {
    return { reason: 'member_of_protected_group', parents: protectedParents };
  }
  if (facts.primaryGroupMembers) {
    return { reason: 'primary_group', primaryGroupMembers: facts.primaryGroupMembers };
  }
  return null;
}

export function describeGroupDeleteBlock(block: GroupDeleteBlock): string {
  switch (block.reason) {
    case 'critical_system_object':
      return 'AD marks this group as a critical system object';
    case 'builtin_group':
      return 'this is one of the groups AD creates for itself';
    case 'protected_group':
      return 'this is a protected administrative group (adminCount=1)';
    case 'role_group':
      return `this group grants OpenADUC's ${block.role} role`;
    case 'member_of_protected_group':
      return `this group is a member of the protected group ${(block.parents ?? [])
        .map((p) => p.distinguishedName)
        .join('; ')}`;
    case 'primary_group': {
      const n = block.primaryGroupMembers ?? 0;
      return `this is the primary group of ${n} ${n === 1 ? 'account' : 'accounts'}; give ${n === 1 ? 'it' : 'them'} another primary group first`;
    }
  }
}
