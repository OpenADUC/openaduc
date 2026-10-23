// SPDX-License-Identifier: BUSL-1.1
import { ref } from 'vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';

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

const INVERSE: Record<MembershipChange, MembershipChange> = { add: 'remove', remove: 'add' };

export interface MembershipFailure {
  change: MembershipChange;
  membership: Membership;
  message: string;
}

/**
 * Add a user to a group or remove them from one, one change at a time.
 * `onChanged` gets `undo`, which makes the inverse change the same way; it's
 * null for an undo. The last failure stays in `failure` until it's retried,
 * dismissed or another change starts.
 */
export function useGroupMembership(options: {
  onChanged: (
    change: MembershipChange,
    membership: Membership,
    undo: (() => void) | null,
  ) => void | Promise<void>;
  onFailed?: (
    change: MembershipChange,
    membership: Membership,
    message: string,
  ) => void | Promise<void>;
}) {
  const auth = useAuthStore();
  const pending = ref<{ change: MembershipChange; membership: Membership } | null>(null);
  const failure = ref<MembershipFailure | null>(null);
  let retryFailed: (() => void) | null = null;

  /** `after` runs once the change lands, after `onChanged`, including after a step-up. */
  function add(membership: Membership, after?: () => void | Promise<void>): void {
    start('add', membership, false, after);
  }

  function remove(membership: Membership, after?: () => void | Promise<void>): void {
    start('remove', membership, false, after);
  }

  function start(
    change: MembershipChange,
    membership: Membership,
    undoing: boolean,
    after?: () => void | Promise<void>,
  ): void {
    if (pending.value) return;
    auth.requireStepUp(() => commit(change, membership, undoing, after));
  }

  async function commit(
    change: MembershipChange,
    membership: Membership,
    undoing: boolean,
    after?: () => void | Promise<void>,
  ): Promise<void> {
    if (pending.value) return;
    pending.value = { change, membership };
    dismiss();
    const { userId, groupId } = membership;
    try {
      try {
        if (change === 'add') await api.users.addGroup(userId, { groupId });
        else await api.users.removeGroup(userId, { groupId });
      } catch (err) {
        if (auth.retryAfterStepUp(err, () => commit(change, membership, undoing, after))) return;
        const message = err instanceof ApiError ? err.message : String(err);
        failure.value = { change, membership, message };
        retryFailed = () => start(change, membership, undoing, after);
        await options.onFailed?.(change, membership, message);
        return;
      }
      const undo = undoing ? null : () => start(INVERSE[change], membership, true);
      await options.onChanged(change, membership, undo);
      await after?.();
    } finally {
      pending.value = null;
    }
  }

  function retry(): void {
    retryFailed?.();
  }

  function dismiss(): void {
    failure.value = null;
    retryFailed = null;
  }

  return { pending, add, remove, failure, retry, dismiss };
}
