// SPDX-License-Identifier: BUSL-1.1
import { computed } from 'vue';
import { api } from '../../api/index.js';
import { useUndoableWrite, type UndoOffer, type WriteFailure } from '../lib/undoableWrite.js';

/** A user's or group's membership of a group, with the names to show for each. */
export interface Membership {
  memberKind: 'user' | 'group';
  memberId: string;
  memberLabel: string;
  groupId: string;
  groupLabel: string;
}

export type MembershipChange = 'add' | 'remove';

interface GroupNames {
  id: string;
  name: string | null;
  samAccountName?: string | null;
  distinguishedName: string;
}

/** A user or group, as far as naming it goes. A user may leave out `kind`. */
export type MemberNames =
  | { kind?: 'user'; id: string; displayName: string | null; samAccountName: string }
  | ({ kind: 'group' } & GroupNames);

/** The name to show for a user or group: the first one it has. */
export function memberLabel(m: MemberNames): string {
  return m.kind === 'group'
    ? m.name || m.samAccountName || m.distinguishedName
    : m.displayName || m.samAccountName;
}

export function membershipOf(member: MemberNames, group: GroupNames): Membership {
  return {
    memberKind: member.kind ?? 'user',
    memberId: member.id,
    memberLabel: memberLabel(member),
    groupId: group.id,
    groupLabel: memberLabel({ kind: 'group', ...group }),
  };
}

const WORDS: Record<MembershipChange, { verb: string; done: string; prep: string }> = {
  add: { verb: 'add', done: 'Added', prep: 'to' },
  remove: { verb: 'remove', done: 'Removed', prep: 'from' },
};

/** "add Jane Doe to Sales": what a change does, for "Couldn't …" or ADUC's "Windows cannot …". */
export function membershipChangeText(change: MembershipChange, m: Membership): string {
  const w = WORDS[change];
  return `${w.verb} ${m.memberLabel} ${w.prep} ${m.groupLabel}`;
}

/** "Added Jane Doe to Sales": what a toast says once a change lands. */
export function membershipDoneText(change: MembershipChange, m: Membership): string {
  const w = WORDS[change];
  return `${w.done} ${m.memberLabel} ${w.prep} ${m.groupLabel}`;
}

export interface MembershipEdit {
  change: MembershipChange;
  membership: Membership;
}

export type MembershipFailure = WriteFailure<MembershipEdit>;

const INVERSE: Record<MembershipChange, MembershipChange> = { add: 'remove', remove: 'add' };

/**
 * Add a user or group to a group or remove it from one, one change at a
 * time. A user's change and a group's are the same API operation, made
 * through the member: the user's groups or the group's.
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
    write: ({ change, membership: { memberKind, memberId, groupId } }) => {
      const member = memberKind === 'user' ? api.users : api.groups;
      return change === 'add'
        ? member.addGroup(memberId, { groupId })
        : member.removeGroup(memberId, { groupId });
    },
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
