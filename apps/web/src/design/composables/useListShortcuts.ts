// SPDX-License-Identifier: BUSL-1.1
// The keys on a directory list (users, groups, computers): / searches,
// j and k move a highlight through the rows as the table shows them, and
// Enter opens the highlighted row.

import {
  computed,
  nextTick,
  ref,
  shallowRef,
  watch,
  type ComponentPublicInstance,
  type Ref,
} from 'vue';
import { useShortcuts } from './useShortcuts.js';

// What the lists' PrimeVue DataTable offers beyond its typings: the rows as
// it shows them, filtered and sorted, and its virtual scroller.
interface ListTable extends ComponentPublicInstance {
  processedData?: readonly unknown[];
  getVirtualScrollerRef?: () => {
    scrollToIndex: (index: number) => void;
    getRenderedRange: () => { viewport: { first: number } };
  } | null;
}

export interface ListShortcutOptions<T> {
  /** One and many, e.g. ['user', 'users']. */
  noun: readonly [string, string];
  open: (row: T) => void;
  /** Shows the list's search field, e.g. by opening the Filters drawer. */
  showSearch: () => void;
  /** The search field, once it's shown. */
  searchField: Ref<ComponentPublicInstance | null>;
}

export function useListShortcuts<T extends { id: string }>(opts: ListShortcutOptions<T>) {
  const table = shallowRef<ListTable | null>(null);
  const highlighted = ref<string | null>(null);

  const shown = computed(() => (table.value?.processedData ?? []) as readonly T[]);
  const index = computed(() =>
    highlighted.value === null ? -1 : shown.value.findIndex((r) => r.id === highlighted.value),
  );

  // Focus follows the highlight, so focus leaving the table leaves the
  // highlight behind: Enter mustn't open a row the operator has moved on from.
  function onFocusOut(e: FocusEvent): void {
    const root = table.value?.$el as HTMLElement | undefined;
    if (!root?.contains(e.relatedTarget as Node | null)) highlighted.value = null;
  }
  watch(
    () => table.value?.$el as HTMLElement | undefined,
    (root, old) => {
      old?.removeEventListener('focusout', onFocusOut);
      root?.addEventListener('focusout', onFocusOut);
    },
  );

  const rowAt = (i: number): HTMLElement | null =>
    (table.value?.$el as HTMLElement | undefined)?.querySelector<HTMLElement>(
      `tbody > tr[data-p-index="${i}"]`,
    ) ?? null;

  // Focus follows the highlight, so a screen reader reads the row out;
  // the scroller only renders rows near the viewport, so a row outside it
  // is scrolled to first.
  async function reveal(i: number): Promise<void> {
    await nextTick();
    if (!rowAt(i)) {
      table.value?.getVirtualScrollerRef?.()?.scrollToIndex(i);
      await nextTick();
    }
    const row = rowAt(i);
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: 'nearest' });
  }

  function move(step: 1 | -1): void {
    const rows = shown.value;
    if (rows.length === 0) return;
    // The first move starts from the top of what's in view.
    const from = index.value;
    const next =
      from < 0
        ? (table.value?.getVirtualScrollerRef?.()?.getRenderedRange().viewport.first ?? 0)
        : from + step;
    const i = Math.min(Math.max(next, 0), rows.length - 1);
    highlighted.value = rows[i]!.id;
    void reveal(i);
  }

  async function search(): Promise<void> {
    opts.showSearch();
    await nextTick();
    (opts.searchField.value?.$el as HTMLElement | undefined)?.focus();
  }

  useShortcuts(() => {
    const none = shown.value.length === 0 ? `no ${opts.noun[1]} to move through` : null;
    return [
      { key: '/', label: `Search ${opts.noun[1]}`, section: 'List', run: () => void search() },
      {
        key: 'j',
        label: 'Next row',
        section: 'List',
        unavailable: none,
        repeats: true,
        run: () => move(1),
      },
      {
        key: 'k',
        label: 'Previous row',
        section: 'List',
        unavailable: none,
        repeats: true,
        run: () => move(-1),
      },
      {
        key: 'Enter',
        label: `Open the highlighted ${opts.noun[0]}`,
        section: 'List',
        unavailable: index.value < 0 ? 'no row highlighted' : null,
        run: () => opts.open(shown.value[index.value]!),
      },
    ];
  });

  /** The DataTable's ref. */
  function setTable(el: unknown): void {
    table.value = (el as ListTable | null) ?? null;
  }

  /** The DataTable's `pt`: marks the highlighted row. */
  const pt = computed(() => ({
    bodyRow: ({ props }: { props: { rowData?: { id?: string } } }) =>
      highlighted.value !== null && props.rowData?.id === highlighted.value
        ? { class: 'is-highlighted', 'aria-current': 'true' }
        : {},
  }));

  return { setTable, pt, highlighted };
}
