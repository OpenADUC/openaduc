// SPDX-License-Identifier: BUSL-1.1
import { computed, ref, shallowRef, watch } from 'vue';
import type { GroupDetail, GroupSummary, UserSummary } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { latestRequest } from '../lib/latestRequest.js';

const SEARCH_DELAY_MS = 250;
export const MEMBER_PAGE_SIZE = 10;

export type MemberCandidate = ({ kind: 'user' } & UserSummary) | ({ kind: 'group' } & GroupSummary);

/**
 * Find users and groups to add to a group: whatever matches the query, less
 * the group itself and its current members.
 */
export function useGroupMemberSearch(group: () => GroupDetail | null) {
  const query = ref('');
  const found = shallowRef<MemberCandidate[]>([]);
  const searching = ref(false);
  const searchError = ref<string | null>(null);
  const searches = latestRequest();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const results = computed(() => {
    const g = group();
    const taken = new Set([g?.id, ...(g?.members ?? []).map((m) => m.id)]);
    return found.value.filter((c) => !taken.has(c.id));
  });

  watch(query, (q) => {
    clearTimeout(timer);
    const isCurrent = searches.begin();
    searching.value = false;
    const needle = q.trim();
    if (!needle) {
      found.value = [];
      searchError.value = null;
      return;
    }
    timer = setTimeout(async () => {
      searching.value = true;
      try {
        const [users, groups] = await Promise.all([
          api.users.search({ q: needle, pageSize: MEMBER_PAGE_SIZE }),
          api.groups.search({ q: needle, pageSize: MEMBER_PAGE_SIZE }),
        ]);
        if (!isCurrent()) return;
        found.value = [
          ...users.rows.map((u) => ({ kind: 'user' as const, ...u })),
          ...groups.rows.map((g) => ({ kind: 'group' as const, ...g })),
        ];
        searchError.value = null;
      } catch (err) {
        if (!isCurrent()) return;
        found.value = [];
        searchError.value = err instanceof ApiError ? err.message : String(err);
      } finally {
        if (isCurrent()) searching.value = false;
      }
    }, SEARCH_DELAY_MS);
  });

  function reset(): void {
    query.value = '';
    clearTimeout(timer);
    searches.begin();
    found.value = [];
    searching.value = false;
    searchError.value = null;
  }

  return { query, results, searching, searchError, reset };
}
