// SPDX-License-Identifier: BUSL-1.1
import { computed } from 'vue';
import { api } from '../../api/index.js';
import { useUndoableWrite, type UndoOffer, type WriteFailure } from '../lib/undoableWrite.js';

/** A user's membership of a group, with the names to show for each. */
export interface Membership {
  userId: string;
  userLabel: string;
  groupId: string;
  groupLabel: string;
}

export type MembershipChange = 'add' | 'remove';

export function membershipOf(
  user: { id: string; displayName: string | null; samAccountName: string },
  group: {
    id: string;
    name: string | null;
    samAccountName?: string | null;
    distinguishedName: string;
  },
): Membership {
  return {
    userId: user.id,
    userLabel: user.displayName || user.samAccountName,
    groupId: group.id,
    groupLabel: group.name || group.samAccountName || group.distinguishedName,
  };
}

const WORDS: Record<MembershipChange, { verb: string; done: string; prep: string }> = {
  add: { verb: 'add', done: 'Added', prep: 'to' },
  remove: { verb: 'remove', done: 'Removed', prep: 'from' },
};

/** "add Jane Doe to Sales": what a change does, for "Couldn't …" or ADUC's "Windows cannot …". */
export function membershipChangeText(change: MembershipChange, m: Membership): string {
  const w = WORDS[change];
  return `${w.verb} ${m.userLabel} ${w.prep} ${m.groupLabel}`;
}

/** "Added Jane Doe to Sales": what a toast says once a change lands. */
export function membershipDoneText(change: MembershipChange, m: Membership): string {
  const w = WORDS[change];
  return `${w.done} ${m.userLabel} ${w.prep} ${m.groupLabel}`;
}

export interface MembershipEdit {
  change: MembershipChange;
  membership: Membership;
}

export type MembershipFailure = WriteFailure<MembershipEdit>;

const INVERSE: Record<MembershipChange, MembershipChange> = { add: 'remove', remove: 'add' };

/**
 * Add a user to a group or remove them from one, one change at a time.
 * `onChanged` gets the offer of Undo, which makes the inverse change the
 * same way. The last failure stays in `failure` until it's retried,
 * dismissed or another change starts.
 */
export function useGroupMembership(options: {
  onChanged: (
    change: MembershipChange,
    membership: Membership,
    offer: UndoOffer,
  ) => void | Promise<void>;
  onFailed?: (failure: MembershipFailure) => void | Promise<void>;
}) {
  const writes = useUndoableWrite<MembershipEdit>({
    write: ({ change, membership: { userId, groupId } }) =>
      change === 'add'
        ? api.users.addGroup(userId, { groupId })
        : api.users.removeGroup(userId, { groupId }),
    inverse: ({ change, membership }) => ({ change: INVERSE[change], membership }),
    onDone: ({ change, membership }, offer) => options.onChanged(change, membership, offer),
    onFailed: options.onFailed,
  });
  const pending = computed(() => writes.runningOn());

  /** `after` runs once the change lands, after `onChanged`, including after a step-up. */
  function add(membership: Membership, after?: () => void | Promise<void>): void {
    if (!pending.value) writes.run({ change: 'add', membership }, after);
  }

  function remove(membership: Membership, after?: () => void | Promise<void>): void {
    if (!pending.value) writes.run({ change: 'remove', membership }, after);
  }

  return {
    pending,
    add,
    remove,
    failure: writes.failure,
    retry: writes.retry,
    dismiss: writes.dismiss,
  };
}
