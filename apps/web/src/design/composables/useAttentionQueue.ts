// SPDX-License-Identifier: BUSL-1.1
import { computed, ref, shallowRef, watch } from 'vue';
import type { UserSummary } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { needsAttention } from '../lib/attention.js';
import { latestRequest } from '../lib/latestRequest.js';

/**
 * The accounts needing attention, worst first, `pageSize` at a time.
 *
 * After a write to one, `reread` reads just that account again: its row
 * updates in place, or leaves once it no longer needs attention (and comes
 * back, should an Undo break it again). `handled` takes a row off without
 * reading it, for a fix that leaves a condition on purpose. As rows leave,
 * the next accounts fill the list. `keep` holds a row that left in place,
 * such as while a failure shows on it.
 */
export function useAttentionQueue(options: {
  withinDays: number;
  pageSize: number;
  keep?: (u: UserSummary) => boolean;
}) {
  // Every row fetched, in the order first seen, including ones that left.
  const fetched = shallowRef<UserSummary[]>([]);
  const left = shallowRef<ReadonlySet<string>>(new Set());
  const serverTotal = ref(0);
  // The latest search's rows: the accounts the server still counts.
  const counted = shallowRef<ReadonlySet<string>>(new Set());
  const error = ref<string | null>(null);
  // Why an account couldn't be read back after a write, by id.
  const rereadFailures = shallowRef<ReadonlyMap<string, string>>(new Map());
  const searches = latestRequest();

  const shown = (u: UserSummary) => !left.value.has(u.id) || (options.keep?.(u) ?? false);
  const rows = computed(() => fetched.value.filter(shown));
  // The server still counts a row that left when it's done so on purpose
  // or the cache hasn't caught up.
  const total = computed(
    () =>
      serverTotal.value - fetched.value.filter((u) => !shown(u) && counted.value.has(u.id)).length,
  );

  async function search(pageSize: number): Promise<UserSummary[] | null> {
    const isCurrent = searches.begin();
    const r = await api.users.search({
      page: 1,
      pageSize,
      issues: true,
      issuesWithinDays: options.withinDays,
      // Worst first, in the order the user's page names conditions.
      sort: 'status',
      sortDir: 'asc',
    });
    if (!isCurrent()) return null;
    serverTotal.value = r.total;
    counted.value = new Set(r.rows.map((u) => u.id));
    return r.rows;
  }

  async function load(): Promise<void> {
    error.value = null;
    left.value = new Set();
    rereadFailures.value = new Map();
    try {
      const found = await search(options.pageSize);
      if (found) fetched.value = found;
    } catch (err) {
      fetched.value = [];
      serverTotal.value = 0;
      error.value = err instanceof Error ? err.message : 'Failed to load';
    }
  }

  // Searches past every row already fetched, since rows that left on
  // purpose still match, and appends the next ones.
  async function fill(): Promise<void> {
    const room = options.pageSize - rows.value.length;
    if (room <= 0 || total.value <= rows.value.length) return;
    let found: UserSummary[] | null;
    try {
      found = await search(fetched.value.length + options.pageSize);
    } catch {
      return; // The rows already shown stay; the next fix tries again.
    }
    if (!found) return;
    const have = new Set(fetched.value.map((u) => u.id));
    const fresh = found.filter((u) => !have.has(u.id));
    fetched.value = [...fetched.value, ...fresh.slice(0, room)];
  }

  watch(
    () => rows.value.length,
    (now, was) => {
      if (now < was) void fill();
    },
  );

  function setLeft(id: string, gone: boolean): void {
    if (left.value.has(id) === gone) return;
    const next = new Set(left.value);
    if (gone) next.add(id);
    else next.delete(id);
    left.value = next;
  }

  function setRereadFailure(id: string, message: string | null): void {
    if (message === null && !rereadFailures.value.has(id)) return;
    const next = new Map(rereadFailures.value);
    if (message !== null) next.set(id, message);
    else next.delete(id);
    rereadFailures.value = next;
  }

  async function reread(id: string): Promise<void> {
    if (!fetched.value.some((u) => u.id === id)) return;
    setRereadFailure(id, null);
    let user: UserSummary;
    try {
      user = (await api.users.get(id)).user;
    } catch (err) {
      setRereadFailure(id, err instanceof Error ? err.message : String(err));
      return;
    }
    fetched.value = fetched.value.map((u) => (u.id === user.id ? user : u));
    setLeft(user.id, !needsAttention(user, options.withinDays));
  }

  function handled(id: string): void {
    setLeft(id, true);
  }

  const rereadFailureOn = (id: string): string | null => rereadFailures.value.get(id) ?? null;

  return {
    rows,
    total,
    error,
    load,
    reread,
    handled,
    rereadFailureOn,
    dismissRereadFailure: (id: string) => setRereadFailure(id, null),
  };
}
