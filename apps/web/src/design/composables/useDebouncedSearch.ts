// SPDX-License-Identifier: BUSL-1.1
import { computed, ref, shallowRef, watch } from 'vue';
import { ApiError } from '../../api/client.js';
import { latestRequest } from '../lib/latestRequest.js';

/**
 * Search as the operator types: wait for a pause, skip queries shorter
 * than `minLength`, and show only the latest search's answer. A failed
 * search says why in `searchError` rather than finding nothing.
 */
export function useDebouncedSearch<T>(options: {
  search: (q: string) => Promise<{ rows: T[]; total: number }>;
  minLength?: number;
  delayMs: number;
}) {
  const minLength = options.minLength ?? 1;
  const query = ref('');
  const results = shallowRef<T[]>([]);
  const total = ref(0);
  const searching = ref(false);
  const searchError = ref<string | null>(null);
  const searches = latestRequest();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const queryTooShort = computed(() => query.value.trim().length < minLength);

  function clear(): void {
    clearTimeout(timer);
    searches.begin();
    results.value = [];
    total.value = 0;
    searching.value = false;
    searchError.value = null;
  }

  watch(query, (q) => {
    if (queryTooShort.value) return clear();
    clearTimeout(timer);
    const isCurrent = searches.begin();
    searching.value = false;
    timer = setTimeout(async () => {
      searching.value = true;
      try {
        const found = await options.search(q.trim());
        if (!isCurrent()) return;
        results.value = found.rows;
        total.value = found.total;
        searchError.value = null;
      } catch (err) {
        if (!isCurrent()) return;
        results.value = [];
        total.value = 0;
        searchError.value = err instanceof ApiError ? err.message : String(err);
      } finally {
        if (isCurrent()) searching.value = false;
      }
    }, options.delayMs);
  });

  /** Empty the query and forget any results, including a search still running. */
  function reset(): void {
    query.value = '';
    clear();
  }

  return { query, queryTooShort, results, total, searching, searchError, reset };
}
