// SPDX-License-Identifier: BUSL-1.1
// Bulk unlock / enable / disable over a selection of users, run as a job
// on the server.
//
// Every bulk action asks first: it changes more than one account, and
// there's no undo for a whole run. The job carries on if the operator
// leaves the page; coming back shows its progress or result. When it's
// done, the failed accounts stay selected, each with its error, so the
// operator can see why and retry them.

import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, type Ref } from 'vue';
import type { ToastServiceMethods } from 'primevue/toastservice';
import type { BulkJob, BulkJobAction } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { accounts, BULK_VERBS, bulkJobActive } from '../lib/bulkJob.js';

export type BulkAction = 'disable' | 'enable' | 'unlock';

const CONSEQUENCE: Record<BulkAction, string> = {
  disable: "They won't be able to sign in until an operator enables them again.",
  enable: 'They can sign in again straight away.',
  unlock: 'Locked accounts can sign in again straight away.',
};

const actionOf = (action: BulkAction): BulkJobAction => `user.${action}`;
const bulkActionOf = (action: BulkJobAction): BulkAction => action.slice(5) as BulkAction;

/** The job last dismissed here, so coming back doesn't show it again. */
const DISMISSED_KEY = 'openaduc.bulkJob.dismissed';
/** A finished job older than this isn't shown on coming back. */
const RESULT_SHOWN_FOR_MS = 24 * 60 * 60 * 1000;

function dismissedId(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function rememberDismissed(id: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, id);
  } catch {
    // Without storage, a dismissed result shows again next visit.
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function useBulkActions(opts: {
  selectedIds: Ref<Set<string>>;
  toast: Pick<ToastServiceMethods, 'add'>;
  /** Reload the list once a job finishes. */
  reload: () => Promise<void>;
  pollMs?: number;
}) {
  const auth = useAuthStore();
  const pollMs = opts.pollMs ?? 1000;
  const job = shallowRef<BulkJob | null>(null);
  // Errors from the job shown, per user, until the next run.
  const bulkErrors = ref(new Map<string, string>());
  const confirming = ref<BulkAction | null>(null);
  /** Starting, continuing, retrying or stopping the job failed. */
  const jobFailure = ref<string | null>(null);
  const busy = ref(false);

  // A job that hasn't stopped holds the selection's actions back.
  const bulkRunning = computed(
    () =>
      busy.value ||
      (job.value !== null && (job.value.status === 'paused' || bulkJobActive(job.value))),
  );
  const pendingBulkAction = computed<BulkAction | null>(() =>
    job.value && bulkJobActive(job.value) ? bulkActionOf(job.value.action) : null,
  );

  // The question for the action waiting to be confirmed.
  const confirmation = computed(() => {
    const action = confirming.value;
    if (!action) return null;
    const { verb } = BULK_VERBS[actionOf(action)];
    const n = opts.selectedIds.value.size;
    return {
      title: `${verb} ${accounts(n)}?`,
      confirmLabel: `${verb} ${n === 1 ? 'account' : accounts(n)}`,
      consequence: CONSEQUENCE[action],
    };
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      clearTimeout(timer);
    });
  }

  /**
   * Show `next`, then poll it while it runs and settle it once it stops.
   * `announce`: the operator saw it run, so a full success is told in a
   * toast and leaves no panel; coming back to one, the panel says it.
   */
  async function show(next: BulkJob, announce = true): Promise<void> {
    job.value = next;
    clearTimeout(timer);
    if (bulkJobActive(next)) {
      timer = setTimeout(() => void poll(next.id), pollMs);
      return;
    }
    if (next.status === 'finished' || next.status === 'cancelled') await settle(next, announce);
  }

  async function poll(id: string): Promise<void> {
    if (disposed || job.value?.id !== id) return;
    try {
      const { job: latest } = await api.bulkJobs.get(id, { background: true });
      if (job.value?.id === id) await show(latest);
    } catch {
      // A missed poll is retried; the job runs regardless.
      if (!disposed && job.value?.id === id) {
        timer = setTimeout(() => void poll(id), pollMs * 3);
      }
    }
  }

  async function settle(done: BulkJob, announce: boolean): Promise<void> {
    const { rows: failures } =
      done.counts.failed > 0 ? await api.bulkJobs.rows(done.id, 'failed') : { rows: [] };
    if (job.value?.id !== done.id) return;
    const { succeeded } = done.counts;
    const { ed } = BULK_VERBS[done.action];
    if (failures.length === 0) {
      opts.selectedIds.value = new Set();
      bulkErrors.value = new Map();
      if (done.status === 'finished' && announce) {
        opts.toast.add({
          severity: 'success',
          summary: `${ed} ${accounts(succeeded)}`,
          life: 4000,
        });
        dismissJob();
      }
    } else {
      // Failures stay on screen, in the job's panel and under each name.
      opts.selectedIds.value = new Set(failures.map((f) => f.targetId));
      bulkErrors.value = new Map(
        failures.map((f) => [f.targetId, f.errorMessage ?? f.errorCode ?? 'Failed']),
      );
    }
    await opts.reload();
  }

  /** Make a write to the job, prompting step-up first and retrying after one. */
  function write(call: () => Promise<{ job: BulkJob }>, stepUp: boolean): void {
    const attempt = async (): Promise<void> => {
      jobFailure.value = null;
      busy.value = true;
      try {
        const { job: next } = await call();
        await show(next);
      } catch (err) {
        if (auth.retryAfterStepUp(err, attempt)) return;
        jobFailure.value = message(err);
      } finally {
        busy.value = false;
      }
    };
    if (stepUp) auth.requireStepUp(attempt);
    else void attempt();
  }

  function requestBulk(action: BulkAction): void {
    if (opts.selectedIds.value.size === 0) return;
    confirming.value = action;
  }

  function cancelBulk(): void {
    confirming.value = null;
  }

  /** Start the confirmed action on the selection. */
  function startBulk(action: BulkAction): void {
    const ids = Array.from(opts.selectedIds.value);
    if (ids.length === 0) return;
    confirming.value = null;
    bulkErrors.value = new Map();
    write(() => api.bulkJobs.start(actionOf(action), ids), true);
  }

  function continueJob(): void {
    const current = job.value;
    if (current) write(() => api.bulkJobs.resume(current.id), true);
  }

  function retryFailed(): void {
    const current = job.value;
    if (!current) return;
    bulkErrors.value = new Map();
    write(() => api.bulkJobs.retry(current.id), true);
  }

  function stopJob(): void {
    const current = job.value;
    if (current) write(() => api.bulkJobs.cancel(current.id), false);
  }

  function dismissJob(): void {
    if (job.value) rememberDismissed(job.value.id);
    clearTimeout(timer);
    job.value = null;
    jobFailure.value = null;
    bulkErrors.value = new Map();
  }

  /** Coming back to the list: show the operator's latest job, unless it's old news. */
  async function restore(): Promise<void> {
    try {
      const [latest] = (await api.bulkJobs.list(1)).jobs;
      if (!latest || latest.id === dismissedId()) return;
      const stoppedAt = latest.finishedAt ? new Date(latest.finishedAt).getTime() : null;
      if (stoppedAt !== null && Date.now() - stoppedAt > RESULT_SHOWN_FOR_MS) return;
      await show(latest, false);
    } catch {
      // The list works without it.
    }
  }

  return {
    job,
    pendingBulkAction,
    bulkRunning,
    bulkErrors,
    jobFailure,
    confirming,
    confirmation,
    requestBulk,
    cancelBulk,
    startBulk,
    continueJob,
    retryFailed,
    stopJob,
    dismissJob,
    restore,
  };
}
