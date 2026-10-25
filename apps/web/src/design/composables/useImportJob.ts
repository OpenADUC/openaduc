// SPDX-License-Identifier: BUSL-1.1
// An import's job, as its results page shows it: its progress while it
// runs, then each row's result, the retry of what failed, and the results
// CSV. In generate and set modes the CSV holds the passwords and can be
// downloaded once; after that, or once they're purged, the page says so
// and offers to reset the new accounts' passwords, a job of its own whose
// CSV hands the new passwords out the same way.

import { computed, ref, shallowRef } from 'vue';
import {
  HELD_PASSWORD_HOURS,
  bulkJobStopped,
  type BulkJob,
  type BulkJobResultsDownload,
  type HeldPasswords,
  type HeldPasswordsState,
  type ImportJobResponse,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { bulkJobActive, bulkJobProblems } from '../lib/bulkJob.js';
import { errorMessage } from '../lib/errorMessage.js';
import { fmtAbsolute } from '../lib/format.js';
import { useJobPolling } from './useJobPolling.js';

const RESET = 'needs a password reset: reset them all below, or one at a time from their page.';

const RESULTS_NOTE: Record<HeldPasswordsState, (r: HeldPasswords) => string> = {
  none: () =>
    'Each person’s row, username and UPN. No passwords: in random mode nobody knows them.',
  held: (r) =>
    `Each person’s row, username, UPN and password. You can download it once${r.expiresAt ? `, until ${fmtAbsolute(r.expiresAt)}` : `, within ${HELD_PASSWORD_HOURS} hours of the import finishing`}; then the passwords are deleted.`,
  downloaded: (r) =>
    `The results, with the passwords, were downloaded ${fmtAbsolute(r.downloadedAt)}, so OpenADUC no longer holds them. Anyone who didn’t get theirs ${RESET}`,
  expired: () =>
    `Nobody downloaded the passwords within ${HELD_PASSWORD_HOURS} hours, so they were deleted. Each new account ${RESET}`,
};

const canDownloadFrom = (job: BulkJob | null, results: HeldPasswords | null): boolean =>
  !!job && bulkJobStopped(job) && (results?.passwords === 'none' || results?.passwords === 'held');

export function useImportJob(opts: {
  /** Hand a results CSV to the browser. */
  save: (file: BulkJobResultsDownload) => void;
}) {
  const auth = useAuthStore();
  const data = shallowRef<ImportJobResponse | null>(null);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  /** Continuing, retrying, stopping or starting a reset failed. */
  const failure = ref<string | null>(null);
  const busy = ref(false);
  const downloading = ref(false);
  const downloadError = ref<string | null>(null);
  const confirmingReset = ref(false);

  let id: string | null = null;
  const polling = useJobPolling(poll);

  const job = computed(() => data.value?.job ?? null);
  const rows = computed(() => data.value?.rows ?? []);
  const results = computed(() => data.value?.results ?? null);
  const reset = computed(() => data.value?.passwordReset ?? null);
  /** The import issues TAPs for class: whether anyone is still unsynced close to it. */
  const classTap = computed(() => data.value?.classTap ?? null);
  const stopped = computed(() => !!job.value && bulkJobStopped(job.value));

  /** Whichever of the import and its reset may still change, for polling. */
  const followed = (next: ImportJobResponse): BulkJob => {
    const r = next.passwordReset?.job;
    return r && (bulkJobActive(r) || r.status === 'paused') ? r : next.job;
  };

  async function load(background: boolean): Promise<void> {
    const current = id;
    if (!current) return;
    const wasActive = !!data.value && bulkJobActive(followed(data.value));
    try {
      const next = await api.users.import.job(current, { background });
      if (current !== id || polling.disposed) return;
      data.value = next;
      loadError.value = null;
      polling.follow(current, followed(next), wasActive);
    } catch (err) {
      if (current !== id || polling.disposed) return;
      if (background) polling.retryLater(current);
      else loadError.value = errorMessage(err, 'Couldn’t load the import');
    }
  }

  async function poll(current: string): Promise<void> {
    if (current === id) await load(true);
  }

  async function open(jobId: string): Promise<void> {
    id = jobId;
    polling.stop();
    data.value = null;
    loading.value = true;
    try {
      await load(false);
    } finally {
      loading.value = false;
    }
  }

  /** Make a write to the import or its reset, prompting step-up first and retrying after one. */
  function control(call: () => Promise<unknown>, stepUp: boolean): void {
    const attempt = async (): Promise<void> => {
      failure.value = null;
      busy.value = true;
      try {
        await call();
        await load(false);
      } catch (err) {
        if (auth.retryAfterStepUp(err, attempt)) return;
        failure.value = errorMessage(err, 'Couldn’t change the job');
      } finally {
        busy.value = false;
      }
    };
    if (stepUp) auth.requireStepUp(attempt);
    else void attempt();
  }

  const ofJob = (call: (jobId: string) => Promise<unknown>) => () => {
    const current = job.value?.id;
    if (current) return call(current);
    return Promise.resolve();
  };
  const ofReset = (call: (jobId: string) => Promise<unknown>) => () => {
    const current = reset.value?.job.id;
    if (current) return call(current);
    return Promise.resolve();
  };

  const continueJob = () => control(ofJob(api.bulkJobs.resume), true);
  /** Run the failed and partial rows again: only the steps each still has to do. */
  const retry = () => control(ofJob(api.bulkJobs.retry), true);
  const stop = () => control(ofJob(api.bulkJobs.cancel), false);
  const continueReset = () => control(ofReset(api.bulkJobs.resume), true);
  const retryReset = () => control(ofReset(api.bulkJobs.retry), true);
  const stopReset = () => control(ofReset(api.bulkJobs.cancel), false);

  /** Rows nobody knows the password of: what a reset is for. */
  const needingReset = computed(() => rows.value.filter((r) => r.needsPasswordReset));
  /** The import's accounts need new passwords, and no reset of them is under way. */
  const canReset = computed(
    () =>
      stopped.value &&
      (results.value?.passwords === 'downloaded' || results.value?.passwords === 'expired') &&
      rows.value.some((r) => r.id !== null) &&
      (!reset.value || bulkJobStopped(reset.value.job)),
  );

  function requestReset(): void {
    if (canReset.value) confirmingReset.value = true;
  }
  function cancelReset(): void {
    confirmingReset.value = false;
  }
  function startReset(): void {
    confirmingReset.value = false;
    control(ofJob(api.bulkJobs.startPasswordReset), true);
  }

  const canDownload = computed(() => canDownloadFrom(job.value, results.value));
  const canDownloadReset = computed(() =>
    canDownloadFrom(reset.value?.job ?? null, reset.value?.results ?? null),
  );

  function downloadOf(jobId: () => string | undefined, allowed: () => boolean): void {
    if (!allowed() || downloading.value) return;
    const attempt = async (): Promise<void> => {
      const current = jobId();
      if (!current || downloading.value) return;
      downloading.value = true;
      downloadError.value = null;
      try {
        opts.save(await api.bulkJobs.results(current));
      } catch (err) {
        if (auth.retryAfterStepUp(err, attempt)) return;
        downloadError.value = errorMessage(err, 'Couldn’t download the results');
      } finally {
        downloading.value = false;
      }
      await load(false);
    };
    auth.requireStepUp(attempt, 'Downloading the results requires step-up authentication.');
  }

  const download = () =>
    downloadOf(
      () => job.value?.id,
      () => canDownload.value,
    );
  const downloadReset = () =>
    downloadOf(
      () => reset.value?.job.id,
      () => canDownloadReset.value,
    );

  /** What the page says of the results CSV and its passwords. */
  const resultsNote = computed(() => {
    const r = results.value;
    return r ? RESULTS_NOTE[r.passwords](r) : null;
  });

  /** What the page says of the reset's CSV. */
  const resetNote = computed(() => {
    const r = reset.value?.results;
    if (!r) return null;
    if (r.passwords === 'downloaded') {
      return `The new passwords were downloaded ${fmtAbsolute(r.downloadedAt)}. Each person must change theirs at sign-in.`;
    }
    if (r.passwords === 'expired') {
      return `Nobody downloaded the new passwords within ${HELD_PASSWORD_HOURS} hours, so they were deleted. Reset them again.`;
    }
    return `Each person’s new password, which they must change at sign-in. You can download it once${r.expiresAt ? `, until ${fmtAbsolute(r.expiresAt)}` : ''}.`;
  });

  /** Rows with something still to do: what a retry runs. */
  const problems = computed(() => (job.value ? bulkJobProblems(job.value.counts) : 0));

  return {
    open,
    loading,
    loadError,
    job,
    rows,
    results,
    classTap,
    stopped,
    problems,
    failure,
    busy,
    continueJob,
    retry,
    stop,
    canDownload,
    download,
    downloading,
    downloadError,
    resultsNote,
    // The password reset
    reset,
    needingReset,
    canReset,
    confirmingReset,
    requestReset,
    cancelReset,
    startReset,
    continueReset,
    retryReset,
    stopReset,
    canDownloadReset,
    downloadReset,
    resetNote,
  };
}
