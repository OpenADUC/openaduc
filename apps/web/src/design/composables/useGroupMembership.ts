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

/** Add a user to a group or remove them from one, one change at a time. */
export function useGroupMembership(options: {
  onChanged: (change: MembershipChange, membership: Membership) => void | Promise<void>;
  onFailed: (
    change: MembershipChange,
    membership: Membership,
    message: string,
  ) => void | Promise<void>;
}) {
  const auth = useAuthStore();
  const pending = ref<{ change: MembershipChange; membership: Membership } | null>(null);

  /** `after` runs once the change lands, after `onChanged`, including after a step-up. */
  function add(membership: Membership, after?: () => void | Promise<void>): void {
    start('add', membership, after);
  }

  function remove(membership: Membership, after?: () => void | Promise<void>): void {
    start('remove', membership, after);
  }

  function start(
    change: MembershipChange,
    membership: Membership,
    after?: () => void | Promise<void>,
  ): void {
    if (pending.value) return;
    auth.requireStepUp(() => commit(change, membership, after));
  }

  async function commit(
    change: MembershipChange,
    membership: Membership,
    after?: () => void | Promise<void>,
  ): Promise<void> {
    if (pending.value) return;
    pending.value = { change, membership };
    const { userId, groupId } = membership;
    try {
      try {
        if (change === 'add') await api.users.addGroup(userId, { groupId });
        else await api.users.removeGroup(userId, { groupId });
      } catch (err) {
        if (auth.retryAfterStepUp(err, () => commit(change, membership, after))) return;
        const message = err instanceof ApiError ? err.message : String(err);
        await options.onFailed(change, membership, message);
        return;
      }
      await options.onChanged(change, membership);
      await after?.();
    } finally {
      pending.value = null;
    }
  }

  return { pending, add, remove };
}
