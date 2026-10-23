// SPDX-License-Identifier: BUSL-1.1
import type { GroupDeleteBlockReason } from '@openaduc/shared';
import { GROUP_TYPE } from '../providers/active-directory/normalize.js';
import { rawScalarValue } from './rawAttributes.js';
import { rawFlag } from './rawAttributes.js';
import { ridOf } from './sid.js';

export interface GroupDeletionCandidate {
  distinguishedName: string;
  sid: string | null;
  rawAttributes: Record<string, unknown>;
}

// Domain Admins (512), Domain Users (513), Cert Publishers (517), … and
// every group in the Builtin domain (S-1-5-32-5xx) have RIDs below 1000.
const FIRST_NON_BUILTIN_RID = 1000;

/**
 * Why this group must not be deleted, or null when it may be. Shared by the
 * preflight and the provider (reading the live entry right before the
 * delete).
 */
export function groupDeleteBlockReason(
  group: GroupDeletionCandidate,
): GroupDeleteBlockReason | null {
  const raw = group.rawAttributes;
  if (rawFlag(raw['isCriticalSystemObject'])) return 'critical_system_object';
  const groupType = Number.parseInt(rawScalarValue(raw['groupType']) ?? '', 10);
  const rid = ridOf(group.sid);
  if (
    /,CN=Builtin,/i.test(group.distinguishedName) ||
    (Number.isFinite(groupType) && (groupType & GROUP_TYPE.builtin) !== 0) ||
    (rid !== null && rid < FIRST_NON_BUILTIN_RID)
  ) {
    return 'builtin_group';
  }
  if (rawScalarValue(raw['adminCount']) === '1') return 'protected_group';
  return null;
}

export function describeGroupDeleteBlock(reason: GroupDeleteBlockReason): string {
  switch (reason) {
    case 'critical_system_object':
      return 'AD marks this group as a critical system object';
    case 'builtin_group':
      return 'this is one of the groups AD creates for itself';
    case 'protected_group':
      return 'this is a protected administrative group (adminCount=1)';
  }
}
