// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from 'vitest';

// A directory of 3 pages; records how many pages the search has produced.
const pagesFetched = { count: 0 };
const user = (n: number) => ({
  dn: `CN=u${n},DC=x`,
  distinguishedName: `CN=u${n},DC=x`,
  objectGUID: Buffer.alloc(16, n),
  sAMAccountName: `u${n}`,
  userAccountControl: '512',
});
const fakeClient = {
  bind: vi.fn(async () => {}),
  unbind: vi.fn(async () => {}),
  async *searchPaginated() {
    for (let p = 0; p < 3; p++) {
      pagesFetched.count++;
      yield { searchEntries: [user(p * 2 + 1), user(p * 2 + 2)], searchReferences: [] };
    }
  },
};
vi.mock('./client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client.js')>()),
  withFailover: async (_config: unknown, fn: (c: unknown) => Promise<unknown>) => fn(fakeClient),
}));

const { ActiveDirectoryProvider } = await import('./provider.js');

describe('syncUsers', () => {
  it('yields entries as pages arrive instead of buffering the whole directory', async () => {
    const provider = new ActiveDirectoryProvider({
      id: 1,
      name: 'test',
      baseDn: 'DC=x',
      ldapUrls: ['ldaps://dc'],
      tlsMode: 'ldaps',
      tlsRejectUnauthorized: true,
      operationTimeoutMs: 1000,
      serviceAccountUpn: 'svc@x',
      serviceAccountPassword: 'pw',
    } as ConstructorParameters<typeof ActiveDirectoryProvider>[0]);

    const it = provider.syncUsers({ pageSize: 2 })[Symbol.asyncIterator]();
    const first = await it.next();

    expect(first.value?.samAccountName).toBe('u1');
    expect(pagesFetched.count).toBe(1);

    let rest = 0;
    for (let r = await it.next(); !r.done; r = await it.next()) rest++;
    expect(rest).toBe(5);
    expect(fakeClient.unbind).toHaveBeenCalled();
  });
});
