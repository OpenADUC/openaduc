// SPDX-License-Identifier: BUSL-1.1
import { computed, ref, watch } from 'vue';
import type { GroupSummary, UserDetail } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { latestRequest } from '../lib/latestRequest.js';
import {
  membershipOf,
  useGroupMembership,
  type Membership,
  type MembershipChange,
} from './useGroupMembership.js';

export const MIN_GROUP_QUERY = 2;
const SEARCH_DELAY_MS = 200;
export const GROUP_PAGE_SIZE = 12;

/** How the user is in a group already: directly, or only through a nested group. */
export type ExistingMembership = 'direct' | 'nested';

/**
 * Find a group by name and add a user to it. Callbacks are as for
 * `useGroupMembership`: an add's `undo` removes the user again, so a change
 * can be a remove. Loading for an account forgets the last failure.
 */
export function useAddToGroup(options: {
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
  const user = ref<UserDetail | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loads = latestRequest();
  const query = ref('');
  const results = ref<GroupSummary[]>([]);
  const total = ref(0);
  const searching = ref(false);
  const searchError = ref<string | null>(null);
  const searches = latestRequest();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const { pending, add: addMembership, failure, retry, dismiss } = useGroupMembership(options);
  const adding = computed(() => pending.value?.membership.groupId ?? null);
  const ready = computed(() => user.value !== null && !loading.value);

  const memberships = computed(
    () =>
      new Map<string, ExistingMembership>(
        user.value?.groupMemberships.map((g) => [g.id, g.direct ? 'direct' : 'nested']),
      ),
  );
  const existing = (groupId: string): ExistingMembership | null =>
    memberships.value.get(groupId) ?? null;
  const queryTooShort = computed(() => query.value.trim().length < MIN_GROUP_QUERY);
  const truncated = computed(() => total.value > results.value.length);

  // Reads the account even when the caller has it, so groups it joined
  // since the caller's read show as memberships.
  async function load(userId: string): Promise<void> {
    const isCurrent = loads.begin();
    user.value = null;
    error.value = null;
    dismiss();
    query.value = '';
    loading.value = true;
    try {
      const u = (await api.users.get(userId)).user;
      if (isCurrent()) user.value = u;
    } catch (err) {
      if (isCurrent()) error.value = err instanceof ApiError ? err.message : String(err);
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  watch(query, (q) => {
    clearTimeout(timer);
    const isCurrent = searches.begin();
    searching.value = false;
    if (queryTooShort.value) {
      results.value = [];
      total.value = 0;
      searchError.value = null;
      return;
    }
    timer = setTimeout(async () => {
      searching.value = true;
      try {
        const resp = await api.groups.search({ q: q.trim(), pageSize: GROUP_PAGE_SIZE });
        if (!isCurrent()) return;
        results.value = resp.rows;
        total.value = resp.total;
        searchError.value = null;
      } catch (err) {
        if (!isCurrent()) return;
        results.value = [];
        total.value = 0;
        searchError.value = err instanceof ApiError ? err.message : String(err);
      } finally {
        if (isCurrent()) searching.value = false;
      }
    }, SEARCH_DELAY_MS);
  });

  /** `after` runs once the user is in the group, after `onChanged`, including after a step-up. */
  function add(group: GroupSummary, after?: () => void | Promise<void>): void {
    const u = user.value;
    if (!u || !ready.value || existing(group.id) === 'direct') return;
    addMembership(membershipOf(u, group), after);
  }

  return {
    user,
    loading,
    error,
    ready,
    query,
    queryTooShort,
    results,
    total,
    truncated,
    searching,
    searchError,
    existing,
    adding,
    load,
    add,
    failure,
    retry,
    dismiss,
  };
}
