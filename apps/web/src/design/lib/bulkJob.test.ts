// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import type { AuditBulkSummary, BulkJobCounts } from '@openaduc/shared';
import { describeBulkEntry } from './bulkJob.js';

const counts = (c: Partial<BulkJobCounts>): BulkJobCounts => ({
  total: 42,
  pending: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  ...c,
});

const summary = (more: Partial<AuditBulkSummary>): AuditBulkSummary => ({
  action: 'user.disable',
  subject: null,
  status: 'finished',
  pauseReason: null,
  total: 42,
  counts: counts({ succeeded: 40, failed: 2 }),
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
        summary({ action: 'user.unlock', total: 1, counts: counts({ total: 1, succeeded: 1 }) }),
        null,
      ),
    ).toEqual({ title: 'Bulk unlock: 1 user', outcome: '1 succeeded · 0 failed', tone: 'green' });
  });

  it('says when it is still running, paused or was stopped', () => {
    const running = counts({ succeeded: 10, failed: 1, pending: 31 });
    expect(describeBulkEntry(summary({ status: 'running', counts: running }), 'J').outcome).toBe(
      'Running: 11 of 42 done',
    );
    expect(describeBulkEntry(summary({ status: 'paused', counts: running }), 'J').outcome).toBe(
      'Paused: 11 of 42 done',
    );
    expect(
      describeBulkEntry(
        summary({ status: 'cancelled', counts: counts({ succeeded: 10, skipped: 32 }) }),
        'J',
      ),
    ).toMatchObject({ outcome: 'Stopped: 10 succeeded · 0 failed', tone: 'amber' });
  });

  it('keeps its heading once the job’s record is gone', () => {
    expect(describeBulkEntry(summary({ status: null, counts: null }), 'Jane Doe')).toEqual({
      title: 'Bulk disable by Jane Doe: 42 users',
      outcome: null,
      tone: 'muted',
    });
  });
});
