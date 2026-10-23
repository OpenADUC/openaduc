// SPDX-License-Identifier: BUSL-1.1
// A directory list's (users, groups, computers) wiring around its table:
// the skeleton rows while it has none yet, the table's loading props, the
// page title, what the page's status region says, and its shortcuts.

import { computed, ref, type ComponentPublicInstance, type Ref } from 'vue';
import { useThemeStore } from '../stores/useTheme.js';
import { useListShortcuts } from './useListShortcuts.js';

export interface ListLoadingOptions<T> {
  rows: Ref<readonly T[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  /** How many there are; the user list counts what the server says. */
  total: () => number;
  /** The page title, e.g. "Users". */
  title: string;
  /** One and many, e.g. ['user', 'users']. */
  noun: readonly [string, string];
  /** Opens a row's page, for Enter. */
  open: (row: T) => void;
  /** Shows the search field, e.g. by opening the Filters drawer, for /. */
  showSearch: () => void;
}

export function useListLoading<T extends { id: string }>(opts: ListLoadingOptions<T>) {
  const theme = useThemeStore();
  // The field / focuses; the page binds it as that field's template ref.
  const searchField = ref<ComponentPublicInstance | null>(null);
  const keys = useListShortcuts<T>({
    noun: opts.noun,
    open: opts.open,
    showSearch: opts.showSearch,
    searchField,
  });

  // A first load, or a reload of an empty list: there are no rows to keep
  // on screen, so the table shows skeleton rows.
  const skeleton = computed(() => opts.loading.value && opts.rows.value.length === 0);

  // For the DataTable: its spinner only over rows it already shows, rows
  // exactly the scroller's item size (see .ds-list-table), and the
  // shortcuts' hold on the table and its highlighted row.
  const table = computed(() => ({
    class: 'ds-list-table',
    loading: opts.loading.value && !skeleton.value,
    virtualScrollerOptions: { itemSize: theme.listRowHeight },
    'aria-busy': opts.loading.value || undefined,
    ref: keys.setTable,
    pt: keys.pt.value,
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

  return { skeleton, table, title, status, searchField };
}
