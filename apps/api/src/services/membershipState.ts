// SPDX-License-Identifier: BUSL-1.1
import type { BulkMembershipOp } from '@openaduc/shared';
import { isDomainSid, ridOf } from '../lib/sid.js';

/** How a user is in a group: in its member, as their primary group, through a nested group, or not. */
export type MembershipState = 'direct' | 'primary' | 'nested' | 'none';

/**
 * How `user` is in `group`. `direct` is whether the group's member holds
 * them; the primary group, which neither member nor memberOf lists, comes
 * from the user's primaryGroupID and the group's SID, so it holds however
 * the group has been renamed or moved.
 */
export function membershipState(
  group: { sid: string | null },
  user: { primaryGroupId: string | null; direct: boolean; nested?: boolean },
): MembershipState {
  if (user.direct) return 'direct';
  const rid = ridOf(group.sid);
  if (rid !== null && isDomainSid(group.sid) && user.primaryGroupId === String(rid)) {
    return 'primary';
  }
  return user.nested ? 'nested' : 'none';
}

/**
 * Whether a membership job leaves this user alone: an add skips members
 * already in it (a primary group's included, which AD won't add to
 * member), and a remove skips anyone not in its member.
 */
export function alreadyAsAsked(op: BulkMembershipOp, state: MembershipState): boolean {
  return op === 'add' ? state === 'direct' || state === 'primary' : state !== 'direct';
}
