// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkJob, BulkJobCounts, ElevatedSessionState } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const ELEVATED: ElevatedSessionState = {
  active: true,
  idleExpiresAt: '2999-01-01T00:15:00.000Z',
  absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
};
const NOT_ELEVATED: ElevatedSessionState = {
  active: false,
  idleExpiresAt: null,
  absoluteExpiresAt: null,
};

const bulkJobs = {
  start: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  rows: vi.fn(),
  resume: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
};
const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
vi.mock('../../api/index.js', () => ({ api: { bulkJobs, auth: { stepUp } } }));

const { POLL, useBulkActions } = await import('./useBulkActions.js');
const { useAuthStore } = await import('../../stores/auth.js');

function aJob(
  status: BulkJob['status'],
  counts: Partial<BulkJobCounts> = {},
  more: Partial<BulkJob> = {},
): BulkJob {
  return {
    id: '7',
    action: 'user.disable',
    subject: null,
    status,
    pauseReason: null,
    actorDisplayName: 'OpenADUC Operator',
    createdAt: new Date().toISOString(),
    finishedAt: status === 'finished' || status === 'cancelled' ? new Date().toISOString() : null,
    counts: {
      total: 3,
      pending: 0,
      running: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
      ...counts,
    },
    ...more,
  };
}

function setup(elevated = ELEVATED) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = { capabilities: [], elevated } as never;
  const selectedIds = ref(new Set(['a', 'b', 'c']));
  const toast = { add: vi.fn() };
  const reload = vi.fn(async () => {});
  const bulk = useBulkActions({ selectedIds, toast, reload });
  return { bulk, auth, selectedIds, toast, reload };
}

const after = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('bulk actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bulkJobs.rows.mockResolvedValue({ rows: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ask for confirmation, then start one job for the whole selection', async () => {
    const { bulk } = setup();
    bulkJobs.start.mockResolvedValue({ job: aJob('queued', { pending: 3 }) });

    bulk.requestBulk('unlock');
    expect(bulk.confirming.value).toBe('unlock');
    expect(bulkJobs.start).not.toHaveBeenCalled();

    bulk.startBulk('unlock');
    await vi.waitFor(() => expect(bulk.job.value?.status).toBe('queued'));
    expect(bulk.confirming.value).toBeNull();
    expect(bulkJobs.start).toHaveBeenCalledExactlyOnceWith('user.unlock', ['a', 'b', 'c']);
  });

  it('say how many accounts they change, and what that means', () => {
    const { bulk, selectedIds } = setup();

    bulk.requestBulk('disable');
    expect(bulk.confirmation.value).toEqual({
      title: 'Disable 3 accounts?',
      confirmLabel: 'Disable 3 accounts',
      consequence: "They won't be able to sign in until an operator enables them again.",
    });
    selectedIds.value = new Set(['a']);
    bulk.requestBulk('unlock');
    expect(bulk.confirmation.value).toEqual({
      title: 'Unlock 1 account?',
      confirmLabel: 'Unlock account',
      consequence: 'Locked accounts can sign in again straight away.',
    });
  });

  it('do nothing when the operator cancels', () => {
    const { bulk } = setup();

    bulk.requestBulk('enable');
    bulk.cancelBulk();
    expect(bulk.confirming.value).toBeNull();
    expect(bulkJobs.start).not.toHaveBeenCalled();
  });

  it('prompts step-up before starting, and starts once stepped up', async () => {
    const { bulk, auth } = setup(NOT_ELEVATED);
    bulkJobs.start.mockResolvedValue({ job: aJob('queued', { pending: 3 }) });

    bulk.startBulk('disable');
    expect(auth.stepUpRequested).toBe(true);
    expect(bulkJobs.start).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(bulkJobs.start).toHaveBeenCalledOnce());
  });

  it('follows the job’s progress, then clears the selection when every account succeeds', async () => {
    const { bulk, selectedIds, toast, reload } = setup();
    bulkJobs.start.mockResolvedValue({ job: aJob('running', { pending: 3 }) });
    bulkJobs.get
      .mockResolvedValueOnce({ job: aJob('running', { pending: 1, running: 1, succeeded: 1 }) })
      .mockResolvedValueOnce({ job: aJob('finished', { succeeded: 3 }) });

    bulk.startBulk('disable');
    await flushPromises();
    expect(bulk.job.value?.status).toBe('running');
    expect(bulk.bulkRunning.value).toBe(true);
    expect(bulk.pendingBulkAction.value).toBe('user.disable');

    await after(POLL.firstMs);
    expect(bulk.job.value?.counts.succeeded).toBe(1);
    expect(bulkJobs.get).toHaveBeenCalledWith('7', { background: true });

    await after(POLL.firstMs * POLL.factor);
    await flushPromises();
    expect(reload).toHaveBeenCalled();
    expect(selectedIds.value.size).toBe(0);
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success', summary: 'Disabled 3 accounts' }),
    );
    expect(bulk.job.value).toBeNull();
    expect(bulk.bulkRunning.value).toBe(false);
  });

  it('keeps only the failed accounts selected, each with its error', async () => {
    const { bulk, selectedIds } = setup();
    bulkJobs.start.mockResolvedValue({ job: aJob('finished', { succeeded: 2, failed: 1 }) });
    bulkJobs.rows.mockResolvedValue({
      rows: [
        {
          targetId: 'b',
          targetName: 'Bob',
          status: 'failed',
          errorCode: 'permission_denied',
          errorMessage: 'The directory refused the change: insufficient access',
        },
      ],
    });

    bulk.startBulk('disable');
    await vi.waitFor(() => expect([...selectedIds.value]).toEqual(['b']));

    expect(bulkJobs.rows).toHaveBeenCalledWith('7', 'failed');
    expect(bulk.bulkErrors.value.get('b')).toBe(
      'The directory refused the change: insufficient access',
    );
    expect(bulk.bulkErrors.value.has('a')).toBe(false);
    expect(bulk.job.value?.status).toBe('finished');
  });

  it('retries the failed rows of the same job', async () => {
    const { bulk } = setup();
    bulkJobs.start.mockResolvedValue({ job: aJob('finished', { succeeded: 2, failed: 1 }) });
    bulkJobs.rows.mockResolvedValue({
      rows: [
        { targetId: 'b', targetName: null, status: 'failed', errorCode: 'x', errorMessage: 'no' },
      ],
    });
    bulkJobs.retry.mockResolvedValue({ job: aJob('queued', { succeeded: 2, pending: 1 }) });
    bulk.startBulk('disable');
    await vi.waitFor(() => expect(bulk.bulkErrors.value.size).toBe(1));

    bulk.retryFailed();

    await vi.waitFor(() => expect(bulk.job.value?.status).toBe('queued'));
    expect(bulkJobs.retry).toHaveBeenCalledExactlyOnceWith('7');
    expect(bulk.bulkErrors.value.size).toBe(0);
  });

  it('shows the operator’s running job on coming back, and follows it', async () => {
    const { bulk, toast } = setup();
    bulkJobs.list.mockResolvedValue({ jobs: [aJob('running', { pending: 2, succeeded: 1 })] });
    bulkJobs.get.mockResolvedValue({ job: aJob('finished', { succeeded: 3 }) });

    await bulk.restore();
    expect(bulk.job.value?.counts.succeeded).toBe(1);

    await after(POLL.firstMs);
    await vi.waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'success' })),
    );
  });

  it('shows a job that finished while the operator was away, without a toast', async () => {
    const { bulk, toast, selectedIds } = setup();
    selectedIds.value = new Set();
    bulkJobs.list.mockResolvedValue({ jobs: [aJob('finished', { succeeded: 3 })] });

    await bulk.restore();

    expect(bulk.job.value?.status).toBe('finished');
    expect(toast.add).not.toHaveBeenCalled();

    bulk.dismissJob();
    expect(bulk.job.value).toBeNull();
    await bulk.restore();
    expect(bulk.job.value).toBeNull();
  });

  it('doesn’t bring back a result from more than a day ago', async () => {
    const { bulk } = setup();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    bulkJobs.list.mockResolvedValue({ jobs: [aJob('finished', {}, { finishedAt: old })] });

    await bulk.restore();

    expect(bulk.job.value).toBeNull();
  });

  it('continues a paused job after a step-up', async () => {
    const { bulk, auth } = setup(NOT_ELEVATED);
    bulkJobs.list.mockResolvedValue({
      jobs: [aJob('paused', { pending: 2, succeeded: 1 }, { pauseReason: 'step_up_required' })],
    });
    bulkJobs.resume.mockResolvedValue({ job: aJob('queued', { pending: 2, succeeded: 1 }) });
    await bulk.restore();
    expect(bulk.bulkRunning.value).toBe(true);

    bulk.continueJob();
    expect(auth.stepUpRequested).toBe(true);
    await auth.stepUp('pw');

    await vi.waitFor(() => expect(bulk.job.value?.status).toBe('queued'));
    expect(bulkJobs.resume).toHaveBeenCalledExactlyOnceWith('7');
  });

  it('asks for step-up again when the session ended before the server saw the request', async () => {
    const { bulk, auth } = setup();
    bulkJobs.start
      .mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'))
      .mockResolvedValueOnce({ job: aJob('queued', { pending: 3 }) });

    bulk.startBulk('enable');
    await vi.waitFor(() => expect(bulkJobs.start).toHaveBeenCalledOnce());
    expect(bulk.jobFailure.value).toBeNull();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(bulk.job.value?.status).toBe('queued'));
  });

  it('polls a running job less and less often, up to every five seconds', async () => {
    const { bulk } = setup();
    bulkJobs.start.mockResolvedValue({ job: aJob('running', { pending: 3 }) });
    bulkJobs.get.mockResolvedValue({ job: aJob('running', { pending: 3 }) });
    bulk.startBulk('disable');
    await flushPromises();

    const gaps: number[] = [];
    let elapsed = 0;
    while (gaps.length < 7) {
      const before = bulkJobs.get.mock.calls.length;
      await after(250);
      elapsed += 250;
      if (bulkJobs.get.mock.calls.length > before) {
        gaps.push(elapsed);
        elapsed = 0;
      }
    }
    expect(gaps).toEqual([1000, 1500, 2250, 3500, 5000, 5000, 5000]);
  });

  it('checks a paused job only now and then, and not while the page is hidden', async () => {
    const { bulk } = setup();
    bulkJobs.list.mockResolvedValue({ jobs: [aJob('paused', { pending: 3 })] });
    bulkJobs.get.mockResolvedValue({ job: aJob('paused', { pending: 3 }) });
    await bulk.restore();

    await after(POLL.pausedMs - 1000);
    expect(bulkJobs.get).not.toHaveBeenCalled();
    await after(1000);
    expect(bulkJobs.get).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await after(POLL.pausedMs * 3);
    expect(bulkJobs.get).toHaveBeenCalledOnce();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(bulkJobs.get).toHaveBeenCalledTimes(2);
  });

  it('selects a finished job’s failed accounts once, not on every visit', async () => {
    const failed = aJob('finished', { succeeded: 2, failed: 1 });
    bulkJobs.list.mockResolvedValue({ jobs: [failed] });
    bulkJobs.rows.mockResolvedValue({
      rows: [
        { targetId: 'b', targetName: null, status: 'failed', errorCode: 'x', errorMessage: 'no' },
      ],
    });

    const first = setup();
    first.selectedIds.value = new Set();
    await first.bulk.restore();
    expect([...first.selectedIds.value]).toEqual(['b']);

    const second = setup();
    second.selectedIds.value = new Set();
    await second.bulk.restore();
    expect(second.selectedIds.value.size).toBe(0);
    expect(second.bulk.bulkErrors.value.get('b')).toBe('no');
  });

  it('stops a job without a step-up, and says why when that fails', async () => {
    const { bulk } = setup(NOT_ELEVATED);
    bulkJobs.list.mockResolvedValue({ jobs: [aJob('paused', { pending: 3 })] });
    bulkJobs.cancel.mockRejectedValueOnce(
      new ApiError(409, 'conflict', 'the job has already stopped'),
    );
    await bulk.restore();

    bulk.stopJob();

    await vi.waitFor(() => expect(bulk.jobFailure.value).toBe('the job has already stopped'));
    expect(bulkJobs.cancel).toHaveBeenCalledExactlyOnceWith('7');
  });
});
