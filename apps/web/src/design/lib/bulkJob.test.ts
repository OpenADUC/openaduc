// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import type { AuditBulkSummary } from '@openaduc/shared';
import { describeBulkEntry } from './bulkJob.js';

const summary = (more: Partial<AuditBulkSummary>): AuditBulkSummary => ({
  action: 'user.disable',
  status: 'finished',
  pauseReason: null,
  total: 42,
  succeeded: 40,
  failed: 2,
  ...more,
});

describe('a bulk job in the audit log', () => {
  it('is headed by its action, operator and size, with how it went', () => {
    expect(describeBulkEntry(summary({}), 'Jane Doe')).toEqual({
      title: 'Bulk disable by Jane Doe: 42 users',
      outcome: '40 succeeded · 2 failed',
      tone: 'red',
    });
    expect(
      describeBulkEntry(
        summary({ action: 'user.unlock', total: 1, succeeded: 1, failed: 0 }),
        null,
      ),
    ).toEqual({ title: 'Bulk unlock: 1 user', outcome: '1 succeeded · 0 failed', tone: 'green' });
  });

  it('says when it is still running, paused or was stopped', () => {
    expect(
      describeBulkEntry(summary({ status: 'running', succeeded: 10, failed: 1 }), 'J').outcome,
    ).toBe('Running: 11 of 42 done');
    expect(
      describeBulkEntry(summary({ status: 'paused', succeeded: 10, failed: 0 }), 'J').outcome,
    ).toBe('Paused: 10 of 42 done');
    expect(
      describeBulkEntry(summary({ status: 'cancelled', succeeded: 10, failed: 0 }), 'J'),
    ).toMatchObject({ outcome: 'Stopped: 10 succeeded · 0 failed', tone: 'amber' });
  });

  it('keeps its heading once the job’s record is gone', () => {
    expect(
      describeBulkEntry(summary({ status: null, succeeded: null, failed: null }), 'Jane Doe'),
    ).toEqual({ title: 'Bulk disable by Jane Doe: 42 users', outcome: null, tone: 'muted' });
  });
});
