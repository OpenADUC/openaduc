// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkJobRevertPreview } from '@openaduc/shared';

const bulkJobs = { revertPreview: vi.fn() };
vi.mock('../../api/index.js', () => ({ api: { bulkJobs } }));

const { revertChangeLabel, revertValueText, useBulkJobRevert } =
  await import('./useBulkJobRevert.js');

const preview = (more: Partial<BulkJobRevertPreview> = {}): BulkJobRevertPreview => ({
  revert: { count: 1, users: [] },
  modified: { count: 2, users: [] },
  unchanged: { count: 0, users: [] },
  notRevertible: { count: 0, users: [] },
  excluded: 0,
  protectedGroups: [],
  previewToken: 'tok',
  ...more,
});

function setup() {
  setActivePinia(createPinia());
  const bulk = { startRevert: vi.fn(), restore: vi.fn() };
  const revert = useBulkJobRevert({ bulk: bulk as never });
  return { bulk, revert };
}

afterEach(() => vi.clearAllMocks());

describe('what a revert says it changes', () => {
  it('names each field, the account, or the group', () => {
    expect(revertChangeLabel({ field: 'department', job: null, now: null, restore: null })).toBe(
      'Department',
    );
    expect(revertChangeLabel({ field: 'enabled', job: false, now: false, restore: true })).toBe(
      'Account',
    );
    expect(
      revertChangeLabel({ field: 'group', group: 'Sales', job: true, now: true, restore: false }),
    ).toBe('Sales');
  });

  it('reads each kind of value', () => {
    expect(revertValueText('enabled', true)).toBe('Enabled');
    expect(revertValueText('group', false)).toBe('Not a member');
    expect(revertValueText('passwordNeverExpires', true)).toBe('Yes');
    expect(revertValueText('accountExpires', null)).toBe('Never');
    expect(revertValueText('ou', 'OU=Staff,DC=corp,DC=example')).toBe('Staff');
    expect(revertValueText('title', null)).toBe('(empty)');
    expect(revertValueText('title', 'Engineer')).toBe('Engineer');
  });
});

describe('reverting a job', () => {
  it('counts the users changed since only once ticked', async () => {
    const { bulk, revert } = setup();
    bulkJobs.revertPreview.mockResolvedValueOnce(preview());
    await revert.open({ jobId: '7', title: 'Bulk disable: 3 users', action: 'user.disable' });

    expect(revert.confirmLabel.value).toBe('Revert 1 account');
    revert.toggle('u2');
    expect(revert.confirmLabel.value).toBe('Revert 2 accounts');
    revert.setIncludeAll(true);
    expect(revert.confirmLabel.value).toBe('Revert 3 accounts');
    revert.confirm();

    expect(bulk.startRevert).toHaveBeenCalledWith(
      '7',
      { previewToken: 'tok', include: 'all', acknowledgeProtected: false },
      expect.any(Function),
    );
  });

  it('asks the operator to acknowledge putting users back in a group AD protects', async () => {
    const { bulk, revert } = setup();
    bulkJobs.revertPreview.mockResolvedValueOnce(
      preview({ protectedGroups: [{ id: 'g1', name: 'Domain Admins' }] }),
    );
    await revert.open({ jobId: '7', title: 'Bulk remove', action: 'user.group.remove' });
    await flushPromises();

    expect(revert.needsAcknowledgement.value).toBe(true);
    expect(revert.canConfirm.value).toBe(false);
    revert.confirm();
    expect(bulk.startRevert).not.toHaveBeenCalled();

    revert.setAcknowledged(true);
    revert.confirm();
    expect(bulk.startRevert).toHaveBeenCalledWith(
      '7',
      { previewToken: 'tok', include: [], acknowledgeProtected: true },
      expect.any(Function),
    );
  });
});
