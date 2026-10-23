// SPDX-License-Identifier: BUSL-1.1
// Bulk unlock / enable / disable over a selection of users.
//
// Every bulk action asks first: it changes more than one account, and
// there's no undo for a whole run. Accounts are done one at a time so a
// failure doesn't stop the rest; the failed ones stay selected, each with
// its error, so the operator can see why and retry.

import { computed, ref, type Ref } from 'vue';
import type { ToastServiceMethods } from 'primevue/toastservice';
import { runBulk } from '../lib/bulk.js';

export type BulkAction = 'disable' | 'enable' | 'unlock';

const CONFIRM: Record<BulkAction, { verb: string; consequence: string }> = {
  disable: {
    verb: 'Disable',
    consequence: "They won't be able to sign in until an operator enables them again.",
  },
  enable: { verb: 'Enable', consequence: 'They can sign in again straight away.' },
  unlock: { verb: 'Unlock', consequence: 'Locked accounts can sign in again straight away.' },
};

export function useBulkActions(opts: {
  selectedIds: Ref<Set<string>>;
  run: Record<BulkAction, (id: string) => Promise<unknown>>;
  toast: Pick<ToastServiceMethods, 'add'>;
  /** Reload the list once a run finishes. */
  reload: () => Promise<void>;
}) {
  const pendingBulkAction = ref<BulkAction | null>(null);
  const bulkRunning = ref(false);
  const bulkProgress = ref<{
    done: number;
    total: number;
    failures: { id: string; error: string }[];
  }>({ done: 0, total: 0, failures: [] });
  // Errors from the last run, per user, shown until the next run.
  const bulkErrors = ref(new Map<string, string>());
  const confirming = ref<BulkAction | null>(null);

  // The question for the action waiting to be confirmed.
  const confirmation = computed(() => {
    const action = confirming.value;
    if (!action) return null;
    const { verb, consequence } = CONFIRM[action];
    const n = opts.selectedIds.value.size;
    const accounts = n === 1 ? '1 account' : `${n} accounts`;
    return {
      title: `${verb} ${accounts}?`,
      confirmLabel: `${verb} ${n === 1 ? 'account' : accounts}`,
      consequence,
    };
  });

  function requestBulk(action: BulkAction): void {
    if (opts.selectedIds.value.size === 0) return;
    confirming.value = action;
  }

  function cancelBulk(): void {
    confirming.value = null;
  }

  async function startBulk(action: BulkAction): Promise<void> {
    if (opts.selectedIds.value.size === 0) return;
    confirming.value = null;
    pendingBulkAction.value = action;
    const ids = Array.from(opts.selectedIds.value);
    bulkRunning.value = true;
    bulkErrors.value = new Map();
    bulkProgress.value = { done: 0, total: ids.length, failures: [] };
    try {
      const result = await runBulk(ids, opts.run[action], (done) => {
        bulkProgress.value = { ...bulkProgress.value, done };
      });
      bulkProgress.value = { ...bulkProgress.value, failures: result.failures };
      const succeeded = result.succeeded.length;
      if (result.failures.length === 0) {
        const verb =
          action === 'disable' ? 'Disabled' : action === 'enable' ? 'Enabled' : 'Unlocked';
        opts.toast.add({
          severity: 'success',
          summary: `${verb} ${succeeded} ${succeeded === 1 ? 'account' : 'accounts'}`,
          life: 4000,
        });
        opts.selectedIds.value = new Set();
      } else {
        opts.toast.add({
          severity: 'warn',
          summary: `${succeeded} succeeded, ${result.failures.length} failed`,
          detail: 'The failed accounts are still selected, with the reason under each name.',
          life: 8000,
        });
        opts.selectedIds.value = new Set(result.failures.map((f) => f.id));
        bulkErrors.value = new Map(result.failures.map((f) => [f.id, f.error]));
      }
      await opts.reload();
    } finally {
      bulkRunning.value = false;
      pendingBulkAction.value = null;
    }
  }

  return {
    pendingBulkAction,
    bulkRunning,
    bulkProgress,
    bulkErrors,
    confirming,
    confirmation,
    requestBulk,
    cancelBulk,
    startBulk,
  };
}
