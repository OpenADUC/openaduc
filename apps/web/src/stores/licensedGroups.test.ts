// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LicensedGroups } from '@openaduc/shared';

const licensed = vi.fn<() => Promise<LicensedGroups>>();
vi.mock('../api/index.js', () => ({ api: { groups: { licensed } } }));

const { useAuthStore } = await import('./auth.js');
const { useLicensedGroupsStore } = await import('./licensedGroups.js');

const e3 = { skuId: 'e3', skuPartNumber: 'SPE_E3', name: 'Microsoft 365 E3' };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const answer = (over: Partial<LicensedGroups> = {}): LicensedGroups => ({
  enabled: true,
  refreshedAt: hoursAgo(0.5),
  refreshFailed: false,
  groups: [{ id: 'g-eng', licenses: [e3] }],
  ...over,
});

function signedInTo(directoryId: number) {
  useAuthStore().actor = { directoryId, capabilities: ['read:group'] } as never;
}

beforeEach(() => {
  vi.useRealTimers();
  setActivePinia(createPinia());
  licensed.mockReset();
  signedInTo(1);
});

describe('licensedGroups', () => {
  it('forgets one directory’s groups on switching to another, and ignores its late answer', async () => {
    const store = useLicensedGroupsStore();
    let answerFirst!: (v: LicensedGroups) => void;
    licensed
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce(answer({ groups: [{ id: 'g-two', licenses: [e3] }] }));
    const first = store.ensureLoaded();

    signedInTo(2);
    const second = store.ensureLoaded();
    expect(second).not.toBe(first);
    await second;
    answerFirst(answer());
    await first;

    expect(store.licensesOf('g-eng')).toEqual([]);
    expect(store.licensesOf('g-two')).toEqual([e3]);
  });

  it('knows nothing after a reload fails, rather than keeping what it had', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = useLicensedGroupsStore();
    licensed.mockResolvedValueOnce(answer()).mockRejectedValueOnce(new Error('offline'));
    await store.ensureLoaded();
    expect(store.licensesOf('g-eng')).toEqual([e3]);

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await store.ensureLoaded();
    expect(store.licensesOf('g-eng')).toEqual([]);
    expect(store.badgeNote).toBe(
      'License badges couldn’t be loaded, so licensed groups aren’t marked.',
    );
  });

  it('says when the badges couldn’t be refreshed, or are old, and nothing when they’re current', async () => {
    const note = async (over: Partial<LicensedGroups>) => {
      setActivePinia(createPinia());
      signedInTo(1);
      licensed.mockResolvedValueOnce(answer(over));
      const store = useLicensedGroupsStore();
      await store.ensureLoaded();
      return store.badgeNote;
    };
    expect(await note({})).toBeNull();
    expect(await note({ refreshFailed: true, refreshedAt: hoursAgo(2) })).toBe(
      'License badges couldn’t be refreshed from Microsoft Entra. Last updated 2h ago.',
    );
    expect(await note({ refreshFailed: true, refreshedAt: null })).toBe(
      'License badges couldn’t be refreshed from Microsoft Entra. They haven’t been read yet.',
    );
    expect(await note({ refreshedAt: hoursAgo(5) })).toBe(
      'License badges may be out of date. Last updated 5h ago.',
    );
    expect(await note({ refreshedAt: null })).toBe(
      'License badges appear once OpenADUC first reads them from Microsoft Entra.',
    );
    expect(await note({ enabled: false, refreshedAt: null, groups: [] })).toBeNull();
  });
});
