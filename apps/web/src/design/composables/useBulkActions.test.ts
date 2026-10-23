// SPDX-License-Identifier: BUSL-1.1
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useBulkActions } from './useBulkActions.js';

function setup(failing: Record<string, string> = {}) {
  const disable = vi.fn(async (id: string) => {
    if (failing[id]) throw new Error(failing[id]);
  });
  const selectedIds = ref(new Set(['a', 'b', 'c']));
  const run = { disable, enable: vi.fn(), unlock: vi.fn() };
  const bulk = useBulkActions({
    selectedIds,
    run,
    toast: { add: vi.fn() },
    reload: vi.fn(async () => {}),
  });
  return { bulk, run, selectedIds };
}

describe('bulk actions', () => {
  it.each(['disable', 'enable', 'unlock'] as const)(
    'ask for confirmation before they %s anyone',
    async (action) => {
      const { bulk, run } = setup();

      bulk.requestBulk(action);
      expect(bulk.confirming.value).toBe(action);
      expect(run[action]).not.toHaveBeenCalled();

      await bulk.startBulk(action);
      expect(bulk.confirming.value).toBeNull();
      expect(run[action]).toHaveBeenCalledTimes(3);
    },
  );

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
    const { bulk, run } = setup();

    bulk.requestBulk('enable');
    bulk.cancelBulk();
    expect(bulk.confirming.value).toBeNull();
    expect(run.enable).not.toHaveBeenCalled();
  });

  it('keeps only the failed accounts selected, each with its error', async () => {
    const { bulk, selectedIds } = setup({ b: 'insufficient access' });

    await bulk.startBulk('disable');

    expect([...selectedIds.value]).toEqual(['b']);
    expect(bulk.bulkErrors.value.get('b')).toBe('insufficient access');
    expect(bulk.bulkErrors.value.has('a')).toBe(false);
  });

  it('clears the selection when every account succeeds', async () => {
    const { bulk, selectedIds } = setup();
    await bulk.startBulk('disable');
    expect(selectedIds.value.size).toBe(0);
  });
});
