// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { BULK_REVERT_ACTIONS, revertedAction, revertRefusal } from './bulkJob.js';

const job = (more: Partial<Parameters<typeof revertRefusal>[0]> = {}) => ({
  action: 'user.disable' as const,
  revertsJobId: null,
  status: 'finished' as const,
  counts: { running: 0, succeeded: 2, partial: 0 },
  ...more,
});

describe('reverting a bulk job', () => {
  it('names the action each revert reverts', () => {
    for (const [action, revert] of Object.entries(BULK_REVERT_ACTIONS)) {
      expect(revertedAction(revert)).toBe(action);
    }
  });

  it('says why a job can’t be reverted now', () => {
    const code = (j: Parameters<typeof revertRefusal>[0], open = false) =>
      revertRefusal(j, open)?.code ?? null;

    expect(code(job())).toBeNull();
    expect(code(job({ action: 'user.unlock' }))).toBe('not_revertible');
    expect(code(job({ action: 'user.enable', revertsJobId: '6' }))).toBe('not_revertible');
    expect(code(job({ status: 'paused' }))).toBe('job_running');
    // Stopped, with a row still finishing.
    expect(
      code(job({ status: 'cancelled', counts: { running: 1, succeeded: 2, partial: 0 } })),
    ).toBe('job_running');
    expect(code(job(), true)).toBe('revert_running');
    expect(code(job({ counts: { running: 0, succeeded: 0, partial: 0 } }))).toBe(
      'nothing_to_revert',
    );
  });
});
