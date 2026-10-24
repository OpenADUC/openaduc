// SPDX-License-Identifier: BUSL-1.1
// An import's job, as its results page shows it: its progress while it
// runs, then each row's result, the retry of what failed, and the results
// CSV. In generate and set modes the CSV holds the passwords and can be
// downloaded once; after that, or once they expire, the page says so and
// the new accounts need their passwords reset.

import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import type {
  BulkJob,
  ImportJobResponse,
  ImportPasswordsState,
  ImportResultsDownload,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { bulkJobActive, bulkJobProblems } from '../lib/bulkJob.js';
import { errorMessage } from '../lib/errorMessage.js';
import { fmtAbsolute } from '../lib/format.js';
import { POLL } from './useBulkActions.js';

type Results = ImportJobResponse['results'];

const RESET = 'needs a password reset: open them below and choose Reset password.';

const RESULTS_NOTE: Record<ImportPasswordsState, (r: Results) => string> = {
  none: () =>
    'Each person’s row, username and UPN. No passwords: in random mode nobody knows them.',
  held: (r) =>
    `Each person’s row, username, UPN and password. You can download it once, until ${fmtAbsolute(r.expiresAt)}; then the passwords are deleted.`,
  downloaded: (r) =>
    `The results, with the passwords, were downloaded ${fmtAbsolute(r.downloadedAt)}, so OpenADUC no longer holds them. Anyone who didn’t get theirs ${RESET}`,
  expired: (r) =>
    `Nobody downloaded the passwords, so they were deleted ${fmtAbsolute(r.expiresAt)}. Each new account ${RESET}`,
};

export function useImportJob(opts: {
  /** Hand the results CSV to the browser. */
  save: (file: ImportResultsDownload) => void;
}) {
  const auth = useAuthStore();
  const data = shallowRef<ImportJobResponse | null>(null);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  /** Continuing, retrying or stopping the job failed. */
  const failure = ref<string | null>(null);
  const busy = ref(false);
  const downloading = ref(false);
  const downloadError = ref<string | null>(null);

  let id: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay: number = POLL.firstMs;
  let disposed = false;
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      clearTimeout(timer);
    });
  }

  const job = computed(() => data.value?.job ?? null);
  const rows = computed(() => data.value?.rows ?? []);
  const results = computed(() => data.value?.results ?? null);
  const stopped = computed(
    () => !!job.value && !bulkJobActive(job.value) && job.value.status !== 'paused',
  );

  function schedule(next: BulkJob, wasActive: boolean): void {
    clearTimeout(timer);
    if (disposed) return;
    if (bulkJobActive(next)) {
      delay = wasActive ? Math.min(delay * POLL.factor, POLL.maxMs) : POLL.firstMs;
      timer = setTimeout(() => void refresh(true), delay);
    } else if (next.status === 'paused') {
      timer = setTimeout(() => void refresh(true), POLL.pausedMs);
    }
  }

  async function refresh(background = false): Promise<void> {
    const current = id;
    if (!current) return;
    try {
      const next = await api.users.import.job(current, { background });
      if (current !== id || disposed) return;
      const wasActive = !!job.value && bulkJobActive(job.value);
      data.value = next;
      loadError.value = null;
      schedule(next.job, wasActive);
    } catch (err) {
      if (current !== id || disposed) return;
      if (background) {
        // A missed poll is retried; the job runs regardless.
        timer = setTimeout(() => void refresh(true), POLL.maxMs);
        return;
      }
      loadError.value = errorMessage(err, 'Couldn’t load the import');
    }
  }

  async function open(jobId: string): Promise<void> {
    id = jobId;
    data.value = null;
    loading.value = true;
    try {
      await refresh();
    } finally {
      loading.value = false;
    }
  }

  /** Make a write to the job, prompting step-up first and retrying after one. */
  function control(call: (id: string) => Promise<unknown>, stepUp: boolean): void {
    const current = id;
    if (!current) return;
    const attempt = async (): Promise<void> => {
      failure.value = null;
      busy.value = true;
      try {
        await call(current);
        await refresh();
      } catch (err) {
        if (auth.retryAfterStepUp(err, attempt)) return;
        failure.value = errorMessage(err, 'Couldn’t change the import');
      } finally {
        busy.value = false;
      }
    };
    if (stepUp) auth.requireStepUp(attempt);
    else void attempt();
  }

  const continueJob = () => control((j) => api.bulkJobs.resume(j), true);
  /** Run the failed and partial rows again: only the steps each still has to do. */
  const retry = () => control((j) => api.bulkJobs.retry(j), true);
  const stop = () => control((j) => api.bulkJobs.cancel(j), false);

  const canDownload = computed(
    () =>
      stopped.value && (results.value?.passwords === 'none' || results.value?.passwords === 'held'),
  );

  function download(): void {
    if (!canDownload.value || downloading.value) return;
    auth.requireStepUp(commitDownload, 'Downloading the results requires step-up authentication.');
  }

  async function commitDownload(): Promise<void> {
    const current = id;
    if (!current || downloading.value) return;
    downloading.value = true;
    downloadError.value = null;
    try {
      opts.save(await api.users.import.results(current));
    } catch (err) {
      if (auth.retryAfterStepUp(err, commitDownload)) return;
      downloadError.value = errorMessage(err, 'Couldn’t download the results');
    } finally {
      downloading.value = false;
    }
    await refresh();
  }

  /** What the page says of the results CSV and its passwords. */
  const resultsNote = computed(() => {
    const r = results.value;
    return r ? RESULTS_NOTE[r.passwords](r) : null;
  });

  /** Rows with something still to do: what a retry runs. */
  const problems = computed(() => (job.value ? bulkJobProblems(job.value.counts) : 0));

  return {
    open,
    refresh,
    loading,
    loadError,
    job,
    rows,
    results,
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
  };
}
