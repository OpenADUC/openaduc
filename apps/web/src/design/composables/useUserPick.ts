// SPDX-License-Identifier: BUSL-1.1
// Pick one user by searching as the operator types, such as the manager a
// bulk edit or a reassignment sets.

import { computed, shallowRef } from 'vue';
import type { UserSummary } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { nameOf } from '../lib/format.js';
import { useDebouncedSearch } from './useDebouncedSearch.js';

const SEARCH_DELAY_MS = 200;
const PAGE_SIZE = 12;

export function useUserPick(options: { exclude?: () => string | null | undefined } = {}) {
  const chosen = shallowRef<{ id: string; name: string } | null>(null);
  const search = useDebouncedSearch<UserSummary>({
    delayMs: SEARCH_DELAY_MS,
    search: (q) => api.users.search({ q, pageSize: PAGE_SIZE }),
  });
  const results = computed(() => {
    const excluded = options.exclude?.();
    return excluded ? search.results.value.filter((u) => u.id !== excluded) : search.results.value;
  });

  function choose(user: UserSummary): void {
    chosen.value = { id: user.id, name: nameOf(user) };
    search.reset();
  }

  function reset(): void {
    chosen.value = null;
    search.reset();
  }

  return {
    chosen,
    query: search.query,
    results,
    searching: search.searching,
    searchError: search.searchError,
    choose,
    reset,
  };
}
