// SPDX-License-Identifier: BUSL-1.1
import { computed, ref, watch } from 'vue';
import type { GroupSummary, UserDetail } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { latestRequest } from '../lib/latestRequest.js';
import { useGroupMembership, type Membership } from './useGroupMembership.js';

export const MIN_GROUP_QUERY = 2;
const SEARCH_DELAY_MS = 200;
const PAGE_SIZE = 12;

/** Find a group by name and add a user to it. */
export function useAddToGroup(options: {
  onAdded: (membership: Membership) => void | Promise<void>;
  onFailed: (message: string) => void | Promise<void>;
}) {
  const user = ref<UserDetail | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const query = ref('');
  const results = ref<GroupSummary[]>([]);
  const searching = ref(false);
  const searches = latestRequest();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const { pending, add: addMembership } = useGroupMembership({
    onChanged: (_change, membership) => options.onAdded(membership),
    onFailed: (_change, _membership, message) => options.onFailed(message),
  });
  const adding = computed(() => pending.value?.membership.groupId ?? null);

  // Nested memberships count too: the user already has what the group grants.
  const memberOf = computed(() => new Set(user.value?.groupMemberships.map((g) => g.id)));
  const isMember = (groupId: string): boolean => memberOf.value.has(groupId);
  const queryTooShort = computed(() => query.value.trim().length < MIN_GROUP_QUERY);

  // Reads the account even when the caller has it, so groups it joined
  // since the caller's read show as memberships.
  async function load(userId: string): Promise<void> {
    user.value = null;
    error.value = null;
    query.value = '';
    results.value = [];
    loading.value = true;
    try {
      user.value = (await api.users.get(userId)).user;
    } catch (err) {
      error.value = err instanceof ApiError ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  watch(query, (q) => {
    clearTimeout(timer);
    const isCurrent = searches.begin();
    searching.value = false;
    if (queryTooShort.value) {
      results.value = [];
      return;
    }
    timer = setTimeout(async () => {
      searching.value = true;
      try {
        const resp = await api.groups.search({ q: q.trim(), pageSize: PAGE_SIZE });
        if (isCurrent()) results.value = resp.rows;
      } catch {
        if (isCurrent()) results.value = [];
      } finally {
        if (isCurrent()) searching.value = false;
      }
    }, SEARCH_DELAY_MS);
  });

  /** `after` runs once the user is in the group, after `onAdded`, including after a step-up. */
  function add(group: GroupSummary, after?: () => void | Promise<void>): void {
    const u = user.value;
    if (!u || isMember(group.id)) return;
    addMembership(
      {
        userId: u.id,
        userLabel: u.displayName ?? u.samAccountName,
        groupId: group.id,
        groupLabel: group.name ?? group.samAccountName ?? group.distinguishedName,
      },
      after,
    );
  }

  return {
    user,
    loading,
    error,
    query,
    queryTooShort,
    results,
    searching,
    isMember,
    adding,
    load,
    add,
  };
}
