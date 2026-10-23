// SPDX-License-Identifier: BUSL-1.1
// Finding users, groups, computers and OUs by name, for quick search and
// the Old School Find dialog. Searches only what the operator can read, and
// one kind failing doesn't hide the others. Only the latest search lands.

import { ref } from 'vue';
import type { ComputerSummary, DirectoryOu, GroupSummary, UserSummary } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { latestRequest } from '../lib/latestRequest.js';

export type SearchKind = 'user' | 'group' | 'computer' | 'ou';

export interface SearchResults {
  user: UserSummary[];
  group: GroupSummary[];
  computer: ComputerSummary[];
  ou: DirectoryOu[];
}

const ALL_KINDS: readonly SearchKind[] = ['user', 'group', 'computer', 'ou'];

// The OU list sits behind read:user on the API, like the OU browser.
const READ: Record<SearchKind, string> = {
  user: 'read:user',
  group: 'read:group',
  computer: 'read:computer',
  ou: 'read:user',
};

const none = (): SearchResults => ({ user: [], group: [], computer: [], ou: [] });

export function useDirectorySearch(options: { pageSize: number }) {
  const auth = useAuthStore();
  const results = ref<SearchResults>(none());
  const failed = ref<SearchKind[]>([]);
  const loading = ref(false);
  const requests = latestRequest();

  // OUs have no search endpoint; the list is small enough to filter here.
  // Fetched once, until the next clear().
  let ouList: Promise<DirectoryOu[]> | null = null;

  async function searchOus(q: string): Promise<DirectoryOu[]> {
    ouList ??= api.ous.list().then((r) => r.ous);
    let all: DirectoryOu[];
    try {
      all = await ouList;
    } catch (err) {
      ouList = null;
      throw err;
    }
    const needle = q.toLowerCase();
    return all
      .map((ou) => ({ ou, at: ou.name.toLowerCase().indexOf(needle) }))
      .filter((m) => m.at >= 0)
      .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || a.ou.name.localeCompare(b.ou.name))
      .slice(0, options.pageSize)
      .map((m) => m.ou);
  }

  const searchers: { [K in SearchKind]: (q: string) => Promise<SearchResults[K]> } = {
    user: async (q) => (await api.users.search({ q, pageSize: options.pageSize })).rows,
    group: async (q) => (await api.groups.search({ q, pageSize: options.pageSize })).rows,
    computer: async (q) => (await api.computers.search({ q, pageSize: options.pageSize })).rows,
    ou: searchOus,
  };

  const canSearch = (kind: SearchKind): boolean => auth.hasCapability(READ[kind]);

  async function search(text: string, kinds: readonly SearchKind[] = ALL_KINDS): Promise<void> {
    const isCurrent = requests.begin();
    const q = text.trim();
    if (!q) {
      results.value = none();
      failed.value = [];
      loading.value = false;
      return;
    }
    loading.value = true;
    const searched = kinds.filter(canSearch);
    const settled = await Promise.allSettled(searched.map((k) => searchers[k](q)));
    if (!isCurrent()) return;
    const next = none();
    searched.forEach((k, i) => {
      const outcome = settled[i]!;
      if (outcome.status === 'fulfilled') (next[k] as unknown) = outcome.value;
    });
    results.value = next;
    failed.value = searched.filter((_, i) => settled[i]!.status === 'rejected');
    loading.value = false;
  }

  function clear(): void {
    requests.begin();
    results.value = none();
    failed.value = [];
    loading.value = false;
    ouList = null;
  }

  return { results, failed, loading, canSearch, search, clear };
}
