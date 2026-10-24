// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BulkJob,
  BulkJobCounts,
  ElevatedSessionState,
  ImportJobResponse,
  ImportJobRow,
} from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const ELEVATED: ElevatedSessionState = {
  active: true,
  idleExpiresAt: '2999-01-01T00:15:00.000Z',
  absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
};

const imports = { job: vi.fn(), results: vi.fn() };
const bulkJobs = { resume: vi.fn(), retry: vi.fn(), cancel: vi.fn() };
vi.mock('../../api/index.js', () => ({
  api: { users: { import: imports }, bulkJobs, auth: { stepUp: vi.fn() } },
}));

const { useImportJob } = await import('./useImportJob.js');
const { POLL } = await import('./useBulkActions.js');
const { useAuthStore } = await import('../../stores/auth.js');

function aJob(status: BulkJob['status'], counts: Partial<BulkJobCounts> = {}): BulkJob {
  return {
    id: '9',
    action: 'user.create',
    subject: { import: { passwordMode: 'generate', mustChange: true, enabled: true } },
    status,
    pauseReason: null,
    revertsJobId: null,
    revertible: false,
    revertedBy: null,
    actorDisplayName: 'OpenADUC Operator',
    createdAt: '2026-10-24T09:00:00.000Z',
    finishedAt: status === 'finished' ? '2026-10-24T09:01:00.000Z' : null,
    counts: {
      total: 2,
      pending: 0,
      running: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
      ...counts,
    },
  };
}

const ROWS: ImportJobRow[] = [
  {
    line: 2,
    displayName: 'Jane Doe',
    samAccountName: 'jane.doe',
    userPrincipalName: 'jane.doe@corp.test',
    status: 'partial',
    id: 'u1',
    completed: ['create', 'password', 'enable', 'manager'],
    failed: [{ step: 'groups', message: 'Not added to Sales: the directory refused the change.' }],
    errorMessage: 'Not added to Sales: the directory refused the change.',
  },
];

function answer(
  job: BulkJob,
  results: Partial<ImportJobResponse['results']> = {},
): ImportJobResponse {
  return {
    job,
    rows: ROWS,
    results: {
      passwords: 'held',
      downloadedAt: null,
      expiresAt: '2026-10-25T09:00:00.000Z',
      ...results,
    },
  };
}

function setup() {
  setActivePinia(createPinia());
  useAuthStore().actor = { capabilities: [], elevated: ELEVATED } as never;
  const save = vi.fn();
  const scope = effectScope();
  const imp = scope.run(() => useImportJob({ save }))!;
  return { imp, save, scope };
}

describe('an import’s results', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows the job while it runs, then shows each row’s result', async () => {
    imports.job
      .mockResolvedValueOnce(answer(aJob('running', { pending: 1, succeeded: 1 })))
      .mockResolvedValue(answer(aJob('finished', { succeeded: 1, partial: 1 })));
    const { imp, scope } = setup();
    await imp.open('9');
    expect(imp.stopped.value).toBe(false);
    expect(imp.canDownload.value).toBe(false);

    await vi.advanceTimersByTimeAsync(POLL.firstMs);
    expect(imports.job).toHaveBeenLastCalledWith('9', { background: true });
    expect(imp.stopped.value).toBe(true);
    expect(imp.problems.value).toBe(1);
    expect(imp.rows.value[0]?.failed[0]?.step).toBe('groups');

    // Stopped: no more polling.
    await vi.advanceTimersByTimeAsync(POLL.maxMs * 2);
    expect(imports.job).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('retries the rows with steps left, then reads the job again', async () => {
    imports.job.mockResolvedValue(answer(aJob('finished', { succeeded: 1, partial: 1 })));
    bulkJobs.retry.mockResolvedValue({ job: aJob('queued') });
    const { imp, scope } = setup();
    await imp.open('9');
    imp.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(bulkJobs.retry).toHaveBeenCalledWith('9');
    expect(imports.job).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('downloads the passwords once, then says they’re gone and to reset them', async () => {
    imports.job.mockResolvedValueOnce(answer(aJob('finished', { succeeded: 2 }))).mockResolvedValue(
      answer(aJob('finished', { succeeded: 2 }), {
        passwords: 'downloaded',
        downloadedAt: '2026-10-24T09:05:00.000Z',
      }),
    );
    const file = { fileName: 'import-9-2026-10-24.csv', csv: 'Row,Status\r\n' };
    imports.results.mockResolvedValue(file);
    const { imp, save, scope } = setup();
    await imp.open('9');
    expect(imp.resultsNote.value).toMatch(/download it once, until/);

    imp.download();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledWith(file);
    expect(imp.canDownload.value).toBe(false);
    expect(imp.resultsNote.value).toMatch(/no longer holds them.*needs a password reset/);
    scope.stop();
  });

  it('says why a download was refused', async () => {
    imports.job.mockResolvedValue(answer(aJob('finished', { succeeded: 2 })));
    imports.results.mockRejectedValue(
      new ApiError(409, 'conflict', 'The results have been downloaded already.'),
    );
    const { imp, save, scope } = setup();
    await imp.open('9');
    imp.download();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).not.toHaveBeenCalled();
    expect(imp.downloadError.value).toBe('The results have been downloaded already.');
    scope.stop();
  });

  it('has no passwords to hand out in random mode, and says so', async () => {
    imports.job.mockResolvedValue(
      answer(aJob('finished', { succeeded: 2 }), { passwords: 'none', expiresAt: null }),
    );
    const { imp, scope } = setup();
    await imp.open('9');
    expect(imp.canDownload.value).toBe(true);
    expect(imp.resultsNote.value).toMatch(/No passwords/);
    scope.stop();
  });
});
