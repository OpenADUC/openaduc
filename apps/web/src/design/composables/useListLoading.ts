// SPDX-License-Identifier: BUSL-1.1
// Loading a directory list (users, groups, computers) into its table: the
// skeleton rows while it has none yet, the table's loading props, the page
// title, and what the page's status region says.

import { computed, type Ref } from 'vue';
import { useThemeStore } from '../stores/useTheme.js';

export interface ListLoadingOptions {
  rows: Ref<readonly unknown[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  /** How many there are; the user list counts what the server says. */
  total: () => number;
  /** The page title, e.g. "Users". */
  title: string;
  /** One and many, e.g. ['user', 'users']. */
  noun: readonly [string, string];
}

export function useListLoading(opts: ListLoadingOptions) {
  const theme = useThemeStore();

  // A first load, or a reload of an empty list: there are no rows to keep
  // on screen, so the table shows skeleton rows.
  const skeleton = computed(() => opts.loading.value && opts.rows.value.length === 0);

  // For the DataTable: its spinner only over rows it already shows, and
  // rows exactly the scroller's item size (see .ds-list-table).
  const table = computed(() => ({
    class: 'ds-list-table',
    loading: opts.loading.value && !skeleton.value,
    virtualScrollerOptions: { itemSize: theme.listRowHeight },
    'aria-busy': opts.loading.value || undefined,
  }));

  const title = computed(() =>
    skeleton.value ? opts.title : `${opts.title} (${opts.total().toLocaleString()})`,
  );

  // Read out by a polite status region outside the busy table.
  const status = computed(() => {
    if (skeleton.value) return `Loading ${opts.noun[1]}…`;
    if (opts.loading.value || opts.error.value) return '';
    const n = opts.total();
    return `${n.toLocaleString()} ${n === 1 ? opts.noun[0] : opts.noun[1]}`;
  });

  return { skeleton, table, title, status };
}
