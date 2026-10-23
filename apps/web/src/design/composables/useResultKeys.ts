// SPDX-License-Identifier: BUSL-1.1
import { computed, ref, watch, type Ref } from 'vue';

export interface KeyedRow<A> {
  key: string;
  /** What the row offers, in order. */
  actions: readonly A[];
}

/** What a key in the search box asks the caller to do. */
export type ResultIntent<R, A> =
  | { kind: 'run'; row: R; action: A }
  | { kind: 'open'; row: R }
  | { kind: 'close' }
  /** Enter before the rows answer the text in the box. */
  | { kind: 'wait' };

/**
 * The keyboard in a search box over rows that may offer actions, with
 * focus staying in the box: ↑↓ highlight a row; → (from the end of the
 * text) or Tab moves into its actions, → and ← through them, ← or
 * Shift+Tab back out; once in them Tab leaves the box as usual. Enter runs
 * the selected action or opens the row, but only once the rows are
 * `ready`, so it never acts on the results of earlier text. Esc leaves the
 * actions, then closes. With `preselect`, a highlighted row's first action
 * is selected as soon as it's highlighted.
 */
export function useResultKeys<A, R extends KeyedRow<A>>(options: {
  rows: Readonly<Ref<readonly R[]>>;
  preselect: () => boolean;
  ready: () => boolean;
}) {
  const highlight = ref(0);
  const actionAt = ref<number | null>(null);
  let keepOn: string | null = null;

  const highlighted = computed(() => options.rows.value[highlight.value] ?? null);
  const selectedAction = computed(() => {
    const at = actionAt.value;
    return at === null ? null : (highlighted.value?.actions[at] ?? null);
  });

  function selectDefault(): void {
    const offers = (highlighted.value?.actions.length ?? 0) > 0;
    actionAt.value = offers && options.preselect() ? 0 : null;
  }

  watch(options.rows, (next) => {
    const at = keepOn ? next.findIndex((r) => r.key === keepOn) : -1;
    keepOn = null;
    highlight.value = Math.max(at, 0);
    selectDefault();
  });
  watch(highlight, selectDefault);

  /** When the rows next change, keep the highlight on this row if it's there. */
  function keepHighlightOn(key: string): void {
    keepOn = key;
  }

  function hover(index: number): void {
    highlight.value = index;
  }

  function reset(): void {
    keepOn = null;
    highlight.value = 0;
    actionAt.value = null;
  }

  function keydown(e: KeyboardEvent, caretAtEnd: boolean): ResultIntent<R, A> | null {
    // Keys that compose text with an input method aren't meant for the list.
    if (e.isComposing || e.keyCode === 229) return null;
    const count = highlighted.value?.actions.length ?? 0;
    const at = actionAt.value;
    switch (e.key) {
      case 'Escape':
        if (at !== null && !options.preselect()) {
          actionAt.value = null;
          return null;
        }
        return { kind: 'close' };
      case 'ArrowDown':
        e.preventDefault();
        highlight.value = Math.min(highlight.value + 1, options.rows.value.length - 1);
        return null;
      case 'ArrowUp':
        e.preventDefault();
        highlight.value = Math.max(highlight.value - 1, 0);
        return null;
      case 'ArrowRight':
        if (count === 0 || !caretAtEnd) return null;
        e.preventDefault();
        actionAt.value = at === null ? 0 : Math.min(at + 1, count - 1);
        return null;
      case 'ArrowLeft':
        if (at === null) return null;
        e.preventDefault();
        actionAt.value = at === 0 ? null : at - 1;
        return null;
      case 'Tab':
        if (e.shiftKey ? at === null : at !== null || count === 0) return null;
        e.preventDefault();
        actionAt.value = e.shiftKey ? null : 0;
        return null;
      case 'Enter': {
        e.preventDefault();
        if (e.repeat) return null;
        if (!options.ready()) return { kind: 'wait' };
        const row = highlighted.value;
        if (!row) return null;
        const action = selectedAction.value;
        return action === null ? { kind: 'open', row } : { kind: 'run', row, action };
      }
    }
    return null;
  }

  return {
    highlight,
    actionAt,
    highlighted,
    selectedAction,
    keepHighlightOn,
    hover,
    reset,
    keydown,
  };
}
