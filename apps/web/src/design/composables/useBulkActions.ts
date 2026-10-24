// SPDX-License-Identifier: BUSL-1.1
// Bulk unlock / enable / disable over a selection of users, adding them
// to groups or removing them from groups, editing their attributes, and
// moving them or changing their account settings, run as a job on the
// server.
//
// Every bulk action asks first: it changes more than one account, and
// there's no undo for a whole run. The job carries on if the operator
// leaves the page; coming back shows its progress or result. When it's
// done, the failed accounts stay selected, each with its error, so the
// operator can see why and retry them.

import { computed, ref, shallowRef, type Ref } from 'vue';
import type { ToastServiceMethods } from 'primevue/toastservice';
import {
  type BulkAccountRequest,
  type BulkJob,
  type BulkJobRevertRequest,
  type BulkUserAttributesRequest,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { accounts, BULK_VERBS, bulkJobActive, bulkJobWords, onImportPage } from '../lib/bulkJob.js';
import { useJobPolling } from './useJobPolling.js';
import type { GroupChange } from './useBulkGroupMembership.js';

/** The bulk actions that change the accounts themselves. */
export type BulkAction = 'disable' | 'enable' | 'unlock';

const CONSEQUENCE: Record<BulkAction, string> = {
  disable: "They won't be able to sign in until an operator enables them again.",
  enable: 'They can sign in again straight away.',
  unlock: 'Locked accounts can sign in again straight away.',
};

/** The job last dismissed here, so coming back doesn't show it again. */
const DISMISSED_KEY = 'openaduc.bulkJob.dismissed';
/** The job whose failed accounts were last selected, so coming back doesn't select them again. */
const SELECTED_KEY = 'openaduc.bulkJob.selected';
/** A finished job older than this isn't shown on coming back. */
const RESULT_SHOWN_FOR_MS = 24 * 60 * 60 * 1000;

export { POLL } from './useJobPolling.js';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, id: string): void {
  try {
    localStorage.setItem(key, id);
  } catch {
    // Without storage, coming back shows or selects it again.
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function useBulkActions(opts: {
  selectedIds: Ref<Set<string>>;
  toast: Pick<ToastServiceMethods, 'add'>;
  /** Reload the list once a job finishes. */
  reload: () => Promise<void>;
}) {
  const auth = useAuthStore();
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
  const pendingBulkAction = computed<BulkJob['action'] | null>(() =>
    job.value && bulkJobActive(job.value) ? job.value.action : null,
  );

  const confirmation = computed(() => {
    const action = confirming.value;
    if (!action) return null;
    const { verb } = BULK_VERBS[`user.${action}`];
    const n = opts.selectedIds.value.size;
    return {
      title: `${verb} ${accounts(n)}?`,
      confirmLabel: `${verb} ${n === 1 ? 'account' : accounts(n)}`,
      consequence: CONSEQUENCE[action],
    };
  });

  // Bumped by detach, so an answer to a request made before isn't shown.
  let attachment = 0;
  const polling = useJobPolling(poll);

  /**
   * Show `next`, then poll it while it may change and settle it once it
   * stops. `announce`: the operator saw it run, so a full success is told
   * in a toast and leaves no panel, and its failed accounts are selected;
   * coming back to one, the panel says it.
   */
  async function show(next: BulkJob, announce = true): Promise<void> {
    const wasActive = job.value?.id === next.id && bulkJobActive(job.value);
    job.value = next;
    if (polling.follow(next.id, next, wasActive)) return;
    await settle(next, announce);
  }

  async function poll(id: string): Promise<void> {
    if (polling.disposed || job.value?.id !== id) return;
    try {
      const { job: latest } = await api.bulkJobs.get(id, { background: true });
      if (job.value?.id === id) await show(latest);
    } catch {
      if (job.value?.id === id) polling.retryLater(id);
    }
  }

  async function settle(done: BulkJob, announce: boolean): Promise<void> {
    const failures = (
      await Promise.all(
        (['failed', 'partial'] as const)
          .filter((status) => done.counts[status] > 0)
          .map(async (status) => (await api.bulkJobs.rows(done.id, status)).rows),
      )
    ).flat();
    if (job.value?.id !== done.id) return;
    const failed = failures.flatMap((f) => (f.targetId === null ? [] : [{ ...f, id: f.targetId }]));
    bulkErrors.value = new Map(
      failed.map((f) => [f.id, f.errorMessage ?? f.errorCode ?? 'Failed']),
    );
    if (announce || stored(SELECTED_KEY) !== done.id) {
      opts.selectedIds.value = new Set(failed.map((f) => f.id));
      store(SELECTED_KEY, done.id);
    }
    if (failures.length === 0 && done.status === 'finished' && announce) {
      const { ed, target } = bulkJobWords(done);
      opts.toast.add({
        severity: 'success',
        summary: `${ed} ${accounts(done.counts.succeeded)}${target}`,
        ...(done.counts.skipped > 0 ? { detail: `${done.counts.skipped} needed no change.` } : {}),
        life: 4000,
      });
      dismissJob();
    }
    await opts.reload();
  }

  /**
   * Make a write to the job, prompting step-up first and retrying after one.
   * `started` hears of the job even if the page has detached meanwhile.
   */
  function write(
    call: () => Promise<{ job: BulkJob }>,
    stepUp: boolean,
    started?: (job: BulkJob) => void,
  ): void {
    const attempt = async (): Promise<void> => {
      const attached = attachment;
      jobFailure.value = null;
      busy.value = true;
      try {
        const { job: next } = await call();
        started?.(next);
        if (attached === attachment) await show(next);
      } catch (err) {
        if (attached !== attachment) return;
        if (auth.retryAfterStepUp(err, attempt)) return;
        jobFailure.value = message(err);
      } finally {
        if (attached === attachment) busy.value = false;
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

  function startBulk(action: BulkAction): void {
    const ids = Array.from(opts.selectedIds.value);
    if (ids.length === 0) return;
    confirming.value = null;
    bulkErrors.value = new Map();
    write(() => api.bulkJobs.start(`user.${action}`, ids), true);
  }

  /** Add users to groups, or remove them, as the operator previewed it. */
  function startGroupChange(change: GroupChange): void {
    if (change.ids.length === 0 || change.groupIds.length === 0) return;
    bulkErrors.value = new Map();
    write(() => api.bulkJobs.startGroupChange(change), true);
  }

  /** Edit the users' attributes as the operator previewed it. */
  function startAttributeEdit(
    edit: BulkUserAttributesRequest,
    started?: (job: BulkJob) => void,
  ): void {
    if (edit.ids.length === 0) return;
    bulkErrors.value = new Map();
    write(() => api.bulkJobs.startAttributeEdit(edit), true, started);
  }

  /** Move the users or change their account settings as the operator previewed it. */
  function startAccountChange(change: BulkAccountRequest): void {
    if (change.ids.length === 0) return;
    bulkErrors.value = new Map();
    write(() => api.bulkJobs.startAccountChange(change), true);
  }

  /** Revert a job as the operator previewed it; `started` hears of the revert's job. */
  function startRevert(
    jobId: string,
    request: BulkJobRevertRequest,
    started?: (job: BulkJob) => void,
  ): void {
    bulkErrors.value = new Map();
    write(() => api.bulkJobs.revert(jobId, request), true, started);
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
    if (job.value) store(DISMISSED_KEY, job.value.id);
    polling.stop();
    job.value = null;
    jobFailure.value = null;
    bulkErrors.value = new Map();
  }

  /**
   * Stop following the job without dismissing it, as when the page moves
   * on to another object: the job carries on, and the list can still show it.
   */
  function detach(): void {
    attachment++;
    polling.stop();
    job.value = null;
    jobFailure.value = null;
    busy.value = false;
    bulkErrors.value = new Map();
  }

  /**
   * Coming back: show the operator's latest job, or the job `id`, unless
   * it's old news.
   */
  async function restore(id?: string): Promise<void> {
    const attached = attachment;
    try {
      const latest = id ? (await api.bulkJobs.get(id)).job : (await api.bulkJobs.list(1)).jobs[0];
      if (attached !== attachment) return;
      // An import's results are on its own page.
      if (!latest || latest.id === stored(DISMISSED_KEY) || onImportPage(latest)) {
        return;
      }
      const stoppedAt = latest.finishedAt ? new Date(latest.finishedAt).getTime() : null;
      if (stoppedAt !== null && Date.now() - stoppedAt > RESULT_SHOWN_FOR_MS) return;
      await show(latest, false);
    } catch {
      // The page works without it.
    }
  }

  return {
    job,
    busy,
    pendingBulkAction,
    bulkRunning,
    bulkErrors,
    jobFailure,
    confirming,
    confirmation,
    requestBulk,
    cancelBulk,
    startBulk,
    startGroupChange,
    startAttributeEdit,
    startAccountChange,
    startRevert,
    continueJob,
    retryFailed,
    stopJob,
    dismissJob,
    detach,
    restore,
  };
}
