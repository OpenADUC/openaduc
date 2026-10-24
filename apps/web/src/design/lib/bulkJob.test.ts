// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import type { AuditBulkSummary, BulkAttributeField, BulkJobCounts } from '@openaduc/shared';
import { describeBulkEntry } from './bulkJob.js';

const counts = (c: Partial<BulkJobCounts>): BulkJobCounts => ({
  total: 42,
  pending: 0,
  running: 0,
  succeeded: 0,
  partial: 0,
  failed: 0,
  skipped: 0,
  ...c,
});

const summary = (more: Partial<AuditBulkSummary>): AuditBulkSummary => ({
  action: 'user.disable',
  subject: null,
  status: 'finished',
  pauseReason: null,
  revertsJobId: null,
  revertible: false,
  revertedBy: null,
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
      reverted: null,
    });
    expect(
      describeBulkEntry(
        summary({ action: 'user.unlock', total: 1, counts: counts({ total: 1, succeeded: 1 }) }),
        null,
      ),
    ).toEqual({
      title: 'Bulk unlock: 1 user',
      outcome: '1 succeeded · 0 failed',
      tone: 'green',
      reverted: null,
    });
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
    ).toMatchObject({ outcome: 'Stopped: 10 succeeded · 0 failed · 32 skipped', tone: 'amber' });
  });

  it('names the groups a membership job changed', () => {
    const groups = (...names: string[]) => ({
      groups: names.map((name, i) => ({ id: `g${i}`, name, distinguishedName: `CN=${name}` })),
    });
    expect(
      describeBulkEntry(summary({ action: 'user.group.add', subject: groups('Sales') }), 'Jane')
        .title,
    ).toBe('Bulk add to Sales by Jane: 42 users');
    expect(
      describeBulkEntry(
        summary({ action: 'user.group.remove', subject: groups('Sales', 'HR', 'Ops') }),
        null,
      ).title,
    ).toBe('Bulk remove from Sales and 2 other groups: 42 users');
  });

  it('names the fields an edit changed', () => {
    const attributes = (...fields: BulkAttributeField[]) => ({
      attributes: fields.map((field) => ({ field, value: null })),
    });
    expect(
      describeBulkEntry(
        summary({ action: 'user.update', subject: attributes('department', 'title') }),
        'Jane',
      ).title,
    ).toBe('Bulk edit (department and title) by Jane: 42 users');
    expect(
      describeBulkEntry(
        summary({
          action: 'user.update',
          subject: attributes('department', 'physicalDeliveryOfficeName', 'l', 'country'),
        }),
        null,
      ).title,
    ).toBe('Bulk edit (department and 3 more fields): 42 users');
  });

  it('names the OU a move went to, and when an expiry ends the accounts', () => {
    const ou = { distinguishedName: 'OU=Leavers,DC=corp', name: 'Leavers' };
    expect(describeBulkEntry(summary({ action: 'user.move', subject: { ou } }), 'J').title).toBe(
      'Bulk move to Leavers by J: 42 users',
    );
    const endOfDay = new Date(2031, 2, 2).toISOString();
    expect(
      describeBulkEntry(
        summary({ action: 'user.accountExpiry.set', subject: { expiresAt: endOfDay } }),
        null,
      ).title,
    ).toBe(`Bulk set expiry to the end of ${new Date(2031, 2, 1).toLocaleDateString()}: 42 users`);
    expect(
      describeBulkEntry(
        summary({ action: 'user.accountExpiry.set', subject: { expiresAt: null } }),
        null,
      ).title,
    ).toBe('Bulk set expiry to never: 42 users');
    expect(
      describeBulkEntry(summary({ action: 'user.passwordNeverExpires.clear' }), null).title,
    ).toBe('Bulk clear “password never expires”: 42 users');
  });

  it('keeps its heading once the job’s record is gone', () => {
    expect(describeBulkEntry(summary({ status: null, counts: null }), 'Jane Doe')).toEqual({
      title: 'Bulk disable by Jane Doe: 42 users',
      outcome: null,
      tone: 'muted',
      reverted: null,
    });
  });

  it('says what a revert reverts, and who reverted a job and when', () => {
    expect(describeBulkEntry(summary({ revertsJobId: '6', total: 40 }), 'Sam Lee').title).toBe(
      'Revert of bulk disable by Sam Lee: 40 users',
    );
    const revertedBy = (status: 'finished' | 'running' | 'cancelled') => ({
      jobId: '8',
      actorDisplayName: 'Sam Lee',
      createdAt: '2026-10-24T09:30:00.000Z',
      status,
    });
    const reverted = (status: 'finished' | 'running' | 'cancelled') =>
      describeBulkEntry(summary({ revertedBy: revertedBy(status) }), 'Jane Doe').reverted;
    expect(reverted('finished')).toMatch(/^Reverted by Sam Lee on .+/);
    expect(reverted('running')).toMatch(/^Being reverted by Sam Lee, since .+/);
    expect(reverted('cancelled')).toMatch(/^Revert by Sam Lee on .+ was stopped$/);
  });
});
