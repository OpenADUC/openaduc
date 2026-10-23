// SPDX-License-Identifier: BUSL-1.1
import { computed } from 'vue';
import type { GroupDetail, GroupSummary, UserSummary } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useDebouncedSearch } from './useDebouncedSearch.js';

export const MEMBER_PAGE_SIZE = 10;

export type MemberCandidate = ({ kind: 'user' } & UserSummary) | ({ kind: 'group' } & GroupSummary);

/**
 * Find users and groups to add to a group: whatever matches the query, less
 * the group itself and its current members.
 */
export function useGroupMemberSearch(group: () => GroupDetail | null) {
  const {
    query,
    results: found,
    searching,
    searchError,
    reset,
  } = useDebouncedSearch<MemberCandidate>({
    delayMs: 250,
    search: async (q) => {
      const [users, groups] = await Promise.all([
        api.users.search({ q, pageSize: MEMBER_PAGE_SIZE }),
        api.groups.search({ q, pageSize: MEMBER_PAGE_SIZE }),
      ]);
      return {
        rows: [
          ...users.rows.map((u) => ({ kind: 'user' as const, ...u })),
          ...groups.rows.map((g) => ({ kind: 'group' as const, ...g })),
        ],
        total: users.total + groups.total,
      };
    },
  });

  const results = computed(() => {
    const g = group();
    const taken = new Set([g?.id, ...(g?.members ?? []).map((m) => m.id)]);
    return found.value.filter((c) => !taken.has(c.id));
  });

  return { query, results, searching, searchError, reset };
}
