// SPDX-License-Identifier: BUSL-1.1
import { computed, type Ref } from 'vue';

/**
 * Where a workflow's last failure shows. Only on the record it belongs to,
 * so a page reused for another record never shows (or retries) the last
 * one's failure; and in the dialog that made it while that's open, else on
 * the page beside what failed.
 */
export function placeFailure<F>(
  failure: Readonly<Ref<F | null>>,
  options: {
    belongsHere: (f: F) => boolean;
    dialog?: { open: () => boolean; made: (f: F) => boolean };
  },
) {
  const shown = computed(() => {
    const f = failure.value;
    return f !== null && options.belongsHere(f) ? f : null;
  });
  const inDialog = computed(() => {
    const f = shown.value;
    return f !== null && options.dialog?.open() && options.dialog.made(f) ? f : null;
  });
  const onPage = computed(() => (inDialog.value === null ? shown.value : null));
  return { inDialog, onPage };
}
