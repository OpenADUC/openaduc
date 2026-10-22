// SPDX-License-Identifier: BUSL-1.1
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useBulkActions } from './useBulkActions.js';

function setup(failing: Record<string, string> = {}) {
  const disable = vi.fn(async (id: string) => {
    if (failing[id]) throw new Error(failing[id]);
  });
  const selectedIds = ref(new Set(['a', 'b', 'c']));
  const bulk = useBulkActions({
    selectedIds,
    run: { disable, enable: vi.fn(), unlock: vi.fn() },
    toast: { add: vi.fn() },
    reload: vi.fn(async () => {}),
  });
  return { bulk, disable, selectedIds };
}

describe('bulk disable', () => {
  it('asks for confirmation before disabling anyone', async () => {
    const { bulk, disable } = setup();

    bulk.requestBulk('disable');
    expect(bulk.confirmDisableOpen.value).toBe(true);
    expect(disable).not.toHaveBeenCalled();

    await bulk.startBulk('disable');
    expect(bulk.confirmDisableOpen.value).toBe(false);
    expect(disable).toHaveBeenCalledTimes(3);
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
