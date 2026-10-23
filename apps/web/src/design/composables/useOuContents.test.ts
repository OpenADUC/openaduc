// SPDX-License-Identifier: BUSL-1.1
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OuContentsResponse } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const contents = vi.fn();
vi.mock('../../api/index.js', () => ({ api: { ous: { contents } } }));

const { useOuContents } = await import('./useOuContents.js');

const withUser = (name: string): OuContentsResponse =>
  ({
    users: [{ id: name, samAccountName: name }],
    groups: [],
    computers: [],
    linkedGroupPolicies: [],
    inheritedGroupPolicies: [],
  }) as never; // only the user's name matters here

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('useOuContents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the OU selected last, whichever answers first', async () => {
    const sales = deferred<OuContentsResponse>();
    const staff = deferred<OuContentsResponse>();
    contents.mockReturnValueOnce(sales.promise).mockReturnValueOnce(staff.promise);
    const ou = useOuContents();

    const salesLoad = ou.load('OU=Sales');
    const staffLoad = ou.load('OU=Staff');
    staff.resolve(withUser('sam'));
    await staffLoad;
    sales.resolve(withUser('sally'));
    await salesLoad;

    expect(ou.contents.value.users.map((u) => u.samAccountName)).toEqual(['sam']);
    expect(ou.loading.value).toBe(false);
  });

  it('empties the list and says why when the contents fail to load', async () => {
    contents.mockResolvedValueOnce(withUser('sam'));
    const ou = useOuContents();
    await ou.load('OU=Sales');

    contents.mockRejectedValueOnce(new ApiError(503, 'directory_unavailable', 'AD is down'));
    await ou.load('OU=Sales');

    expect(ou.contents.value.users).toEqual([]);
    expect(ou.error.value).toBe('AD is down');
  });

  it('drops a load still in flight when cleared', async () => {
    const sales = deferred<OuContentsResponse>();
    contents.mockReturnValueOnce(sales.promise);
    const ou = useOuContents();

    const load = ou.load('OU=Sales');
    ou.clear();
    sales.resolve(withUser('sam'));
    await load;

    expect(ou.contents.value.users).toEqual([]);
    expect(ou.loading.value).toBe(false);
  });
});
