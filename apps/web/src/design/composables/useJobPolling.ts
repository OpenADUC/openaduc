// SPDX-License-Identifier: BUSL-1.1
// Following a bulk job as it runs, for whichever page shows it.

import { getCurrentScope, onScopeDispose } from 'vue';
import type { BulkJob } from '@openaduc/shared';
import { bulkJobActive } from '../lib/bulkJob.js';

/**
 * Polling a running job starts at a second and slows to five, to stay well
 * inside the API's rate limit; a paused job changes only when someone
 * continues it, so it's checked rarely. A stopped one isn't polled.
 */
export const POLL = {
  firstMs: 1000,
  factor: 1.5,
  maxMs: 5000,
  pausedMs: 15_000,
  /** What a stopped job still waits on (an import's licenses settling in Entra) changes slowly. */
  afterStopMs: 30_000,
} as const;

/**
 * Poll a job with `poll` while it may change, as POLL says. A poll that
 * comes due while the page is hidden is made once it's shown again. The
 * scope it's called in stops it.
 */
export function useJobPolling(poll: (id: string) => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay: number = POLL.firstMs;
  let disposed = false;
  // A poll that came due while the page was hidden, made once it's shown.
  let dueWhileHidden: string | null = null;
  const hidden = () => typeof document !== 'undefined' && document.hidden;
  const due = (id: string) => {
    if (disposed) return;
    if (hidden()) {
      dueWhileHidden = id;
      return;
    }
    void poll(id);
  };
  const onVisible = () => {
    const id = dueWhileHidden;
    if (id && !hidden()) {
      dueWhileHidden = null;
      due(id);
    }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    });
  }

  return {
    /**
     * Having shown `job` (polled as `id`), poll again if it may still
     * change: false once it has stopped. `wasActive`: it was running when
     * last shown, so polling slows down.
     */
    follow(id: string, job: BulkJob, wasActive: boolean): boolean {
      clearTimeout(timer);
      if (bulkJobActive(job)) {
        delay = wasActive ? Math.min(delay * POLL.factor, POLL.maxMs) : POLL.firstMs;
        timer = setTimeout(() => due(id), delay);
        return true;
      }
      if (job.status === 'paused') {
        timer = setTimeout(() => due(id), POLL.pausedMs);
        return true;
      }
      return false;
    },
    /** A poll failed: try again in a while; the job runs regardless. */
    retryLater(id: string): void {
      this.after(id, POLL.maxMs);
    },
    /** Poll again in `ms`, for what still changes once the job has stopped. */
    after(id: string, ms: number): void {
      clearTimeout(timer);
      if (!disposed) timer = setTimeout(() => due(id), ms);
    },
    stop(): void {
      clearTimeout(timer);
      dueWhileHidden = null;
    },
    get disposed(): boolean {
      return disposed;
    },
  };
}
