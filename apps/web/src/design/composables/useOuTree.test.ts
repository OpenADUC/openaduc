// SPDX-License-Identifier: BUSL-1.1
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryOu } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const list = vi.fn();
vi.mock('../../api/index.js', () => ({ api: { ous: { list } } }));

const { useOuTree } = await import('./useOuTree.js');

const anOu = (name: string): DirectoryOu =>
  ({ distinguishedName: `OU=${name},DC=corp,DC=example`, name, parentDn: null }) as never;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('useOuTree', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the OUs', async () => {
    list.mockResolvedValueOnce({ ous: [anOu('Sales')] });
    const tree = useOuTree();
    await tree.load();
    expect(tree.ous.value.map((o) => o.name)).toEqual(['Sales']);
    expect(tree.loading.value).toBe(false);
  });

  it('keeps the OUs it has and says why when a reload fails', async () => {
    list.mockResolvedValueOnce({ ous: [anOu('Sales')] });
    const tree = useOuTree();
    await tree.load();

    list.mockRejectedValueOnce(new ApiError(503, 'directory_unavailable', 'AD is down'));
    await tree.load();

    expect(tree.ous.value.map((o) => o.name)).toEqual(['Sales']);
    expect(tree.error.value).toBe('AD is down');
  });

  it('keeps the latest list when an earlier load answers last', async () => {
    const first = deferred<{ ous: DirectoryOu[] }>();
    list.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ous: [anOu('Staff')] });
    const tree = useOuTree();

    const firstLoad = tree.load();
    await tree.load();
    first.resolve({ ous: [anOu('Sales')] });
    await firstLoad;

    expect(tree.ous.value.map((o) => o.name)).toEqual(['Staff']);
  });
});
