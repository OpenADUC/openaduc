// SPDX-License-Identifier: BUSL-1.1
import type { GroupPrivilege, Role } from '@openaduc/shared';
import { rawScalarValue } from './rawAttributes.js';
import { ridOf } from './sid.js';

export interface GroupLike {
  distinguishedName: string;
  sid: string | null;
  rawAttributes: Record<string, unknown>;
}

/** A group mapped to an OpenADUC role: its members get the role at sign-in. */
export interface RoleGroup {
  dn: string;
  role: Role;
}

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

/** The OpenADUC role membership in this group grants, if it's mapped to one. */
export function grantedRole(groupDn: string, roleGroups: readonly RoleGroup[]): Role | undefined {
  const dn = groupDn.toLowerCase();
  return roleGroups.find((g) => g.dn.toLowerCase() === dn)?.role;
}

/** What membership in a group grants: AD's protection first, as the bigger of the two. */
export function groupPrivilege(
  group: GroupLike,
  roleGroups: readonly RoleGroup[],
): GroupPrivilege | null {
  if (isProtectedGroup(group)) return { reason: 'protected' };
  const role = grantedRole(group.distinguishedName, roleGroups);
  return role ? { reason: 'role', role } : null;
}
