// SPDX-License-Identifier: BUSL-1.1
// Loading one directory record for a detail page.
//
// Responses can arrive out of order when the operator moves between
// records (every GET live-refreshes against AD, so they're slow): only the
// latest may land, or B's page could show, and act on, A. Switching to
// another record also drops the previous one at once, so nothing on screen
// refers to it while the new one loads.

import { ref, type Ref } from 'vue';
import type { ToastServiceMethods } from 'primevue/toastservice';
import { ApiError } from '../../api/client.js';
import { latestRequest } from '../lib/latestRequest.js';

export interface DetailRecordOptions<T> {
  id: () => string;
  fetch: (id: string) => Promise<T>;
  notFoundMessage: string;
  failedMessage: string;
  /** Runs at the start of every load, e.g. to drop per-record state. */
  beforeLoad?: () => void;
  /** Runs when the latest load lands. */
  onLoaded?: (record: T) => void;
}

export function useDetailRecord<T extends { id: string }>(opts: DetailRecordOptions<T>) {
  const record = ref(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref<string | null>(null);
  const requests = latestRequest();

  async function load(): Promise<void> {
    const isCurrent = requests.begin();
    const id = opts.id();
    loading.value = true;
    error.value = null;
    if (record.value && record.value.id !== id) record.value = null;
    opts.beforeLoad?.();
    try {
      const loaded = await opts.fetch(id);
      if (!isCurrent()) return;
      record.value = loaded;
      opts.onLoaded?.(loaded);
    } catch (err) {
      if (!isCurrent()) return;
      error.value =
        err instanceof ApiError && err.status === 404
          ? opts.notFoundMessage
          : err instanceof Error
            ? err.message
            : opts.failedMessage;
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  const refreshing = ref(false);
  /** Load again and toast the outcome; load reports failure through `error`. */
  async function refresh(toast: Pick<ToastServiceMethods, 'add'>, success: string): Promise<void> {
    refreshing.value = true;
    try {
      await load();
      if (error.value) {
        toast.add({
          severity: 'error',
          summary: 'Refresh failed',
          detail: error.value,
          life: 5000,
        });
      } else {
        toast.add({ severity: 'success', summary: success, life: 2500 });
      }
    } finally {
      refreshing.value = false;
    }
  }

  return { record, loading, error, load, refreshing, refresh };
}
