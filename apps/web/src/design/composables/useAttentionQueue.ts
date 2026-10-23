// SPDX-License-Identifier: BUSL-1.1
import { ref, shallowRef } from 'vue';
import type { UserSummary } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { needsAttention } from '../lib/attention.js';

export interface RereadFailure {
  account: UserSummary;
  message: string;
}

/**
 * The accounts needing attention, worst first. After a write to one,
 * `reread` reads just that account again: its row updates in place, or
 * counts as `fixed` once it no longer needs attention (and again as not,
 * should an Undo break it), without loading the list again.
 */
export function useAttentionQueue(options: { withinDays: number; pageSize: number }) {
  const rows = shallowRef<UserSummary[]>([]);
  const total = ref(0);
  const error = ref<string | null>(null);
  const fixed = shallowRef<ReadonlySet<string>>(new Set());
  const rereadFailure = shallowRef<RereadFailure | null>(null);

  async function load(): Promise<void> {
    error.value = null;
    fixed.value = new Set();
    rereadFailure.value = null;
    try {
      const r = await api.users.search({
        page: 1,
        pageSize: options.pageSize,
        issues: true,
        issuesWithinDays: options.withinDays,
        // Worst first, in the order the user's page names conditions.
        sort: 'status',
        sortDir: 'asc',
      });
      rows.value = r.rows;
      total.value = r.total;
    } catch (err) {
      rows.value = [];
      total.value = 0;
      error.value = err instanceof Error ? err.message : 'Failed to load';
    }
  }

  async function reread(account: UserSummary): Promise<void> {
    if (rereadFailure.value?.account.id === account.id) rereadFailure.value = null;
    let user: UserSummary;
    try {
      user = (await api.users.get(account.id)).user;
    } catch (err) {
      rereadFailure.value = { account, message: err instanceof Error ? err.message : String(err) };
      return;
    }
    rows.value = rows.value.map((u) => (u.id === user.id ? user : u));
    const next = new Set(fixed.value);
    if (needsAttention(user, options.withinDays)) next.delete(user.id);
    else next.add(user.id);
    fixed.value = next;
  }

  function dismissRereadFailure(): void {
    rereadFailure.value = null;
  }

  return { rows, total, error, fixed, rereadFailure, load, reread, dismissRereadFailure };
}
