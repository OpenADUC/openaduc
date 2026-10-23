// SPDX-License-Identifier: BUSL-1.1
import type { Membership, MembershipChange } from '../design/composables/useGroupMembership.js';

/** What a toast says once a membership change lands. */
export function membershipChanged(change: MembershipChange, m: Membership): string {
  return change === 'add'
    ? `${m.userLabel} added to ${m.groupLabel}.`
    : `${m.userLabel} removed from ${m.groupLabel}.`;
}

/** What the message box says when a membership change fails, in ADUC's words. */
export function membershipFailed(change: MembershipChange, m: Membership, message: string): string {
  const what =
    change === 'add'
      ? `add ${m.userLabel} to ${m.groupLabel}`
      : `remove ${m.userLabel} from ${m.groupLabel}`;
  return `Windows cannot ${what} because:\n${message}`;
}
