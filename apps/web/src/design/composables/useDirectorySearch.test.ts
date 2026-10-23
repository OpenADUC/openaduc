// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  users: { search: vi.fn() },
  groups: { search: vi.fn() },
  computers: { search: vi.fn() },
  ous: { list: vi.fn() },
};
vi.mock('../../api/index.js', () => ({ api }));

const { useDirectorySearch } = await import('./useDirectorySearch.js');
const { useAuthStore } = await import('../../stores/auth.js');

const ALL = ['read:user', 'read:group', 'read:computer'];
const anOu = (name: string) => ({ distinguishedName: `OU=${name},DC=corp,DC=example`, name });

function setup(capabilities = ALL, pageSize = 6) {
  setActivePinia(createPinia());
  useAuthStore().actor = { capabilities } as never; // only capabilities matter here
  return useDirectorySearch({ pageSize });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('useDirectorySearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.users.search.mockResolvedValue({ rows: [{ id: 'u1' }] });
    api.groups.search.mockResolvedValue({ rows: [{ id: 'g1' }] });
    api.computers.search.mockResolvedValue({ rows: [{ id: 'c1' }] });
    api.ous.list.mockResolvedValue({ ous: [anOu('Sales')] });
  });

  it('searches every kind the operator can read, by the trimmed text', async () => {
    const finder = setup(ALL, 100);
    await finder.search('  sal ');
    expect(api.users.search).toHaveBeenCalledWith({ q: 'sal', pageSize: 100 });
    expect(api.groups.search).toHaveBeenCalledWith({ q: 'sal', pageSize: 100 });
    expect(api.computers.search).toHaveBeenCalledWith({ q: 'sal', pageSize: 100 });
    expect(finder.results.value).toEqual({
      user: [{ id: 'u1' }],
      group: [{ id: 'g1' }],
      computer: [{ id: 'c1' }],
      ou: [anOu('Sales')],
    });
  });

  it('leaves out what the operator can’t read; OUs go with users', async () => {
    const finder = setup(['read:computer']);
    expect(finder.canSearch('ou')).toBe(false);
    await finder.search('sal');
    expect(api.users.search).not.toHaveBeenCalled();
    expect(api.groups.search).not.toHaveBeenCalled();
    expect(api.ous.list).not.toHaveBeenCalled();
    expect(finder.results.value.computer).toEqual([{ id: 'c1' }]);
  });

  it('searches only the kinds asked for', async () => {
    const finder = setup();
    await finder.search('sal', ['group']);
    expect(api.groups.search).toHaveBeenCalledOnce();
    expect(api.users.search).not.toHaveBeenCalled();
    expect(api.computers.search).not.toHaveBeenCalled();
    expect(api.ous.list).not.toHaveBeenCalled();
  });

  it('keeps the other kinds’ results when one fails, and says which failed', async () => {
    api.computers.search.mockRejectedValueOnce(new Error('boom'));
    const finder = setup();
    await finder.search('sal');
    expect(finder.failed.value).toEqual(['computer']);
    expect(finder.results.value.user).toEqual([{ id: 'u1' }]);
    expect(finder.results.value.computer).toEqual([]);
  });

  it('finds OUs by name, those starting with the text first, up to the page size', async () => {
    api.ous.list.mockResolvedValueOnce({
      ous: [anOu('Corp'), anOu('West Sales'), anOu('Sales'), anOu('Salt'), anOu('Pre-sales')],
    });
    const finder = setup(ALL, 3);
    await finder.search('SAL', ['ou']);
    expect(finder.results.value.ou.map((o) => o.name)).toEqual(['Sales', 'Salt', 'Pre-sales']);
  });

  it('keeps only the latest search when an earlier one answers last', async () => {
    const slow = deferred<{ rows: { id: string }[] }>();
    api.users.search.mockReturnValueOnce(slow.promise);
    const finder = setup(['read:user']);

    const first = finder.search('sa', ['user']);
    await finder.search('sam', ['user']);
    slow.resolve({ rows: [{ id: 'late' }] });
    await first;

    expect(finder.results.value.user).toEqual([{ id: 'u1' }]);
    expect(finder.loading.value).toBe(false);
  });

  it('drops a search still under way when cleared', async () => {
    const slow = deferred<{ rows: { id: string }[] }>();
    api.users.search.mockReturnValueOnce(slow.promise);
    const finder = setup(['read:user']);

    const search = finder.search('sam', ['user']);
    expect(finder.loading.value).toBe(true);
    finder.clear();
    slow.resolve({ rows: [{ id: 'late' }] });
    await search;

    expect(finder.results.value.user).toEqual([]);
    expect(finder.loading.value).toBe(false);
  });
});
