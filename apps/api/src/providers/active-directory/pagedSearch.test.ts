// SPDX-License-Identifier: BUSL-1.1
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake DC: serves `pages` one page per searchPaginated step and counts
// how many it has produced.
let pages: Record<string, unknown>[][] = [];
const pagesFetched = { count: 0 };
const fakeClient = {
  bind: vi.fn(async () => {}),
  unbind: vi.fn(async () => {}),
  async *searchPaginated() {
    for (const searchEntries of pages) {
      pagesFetched.count++;
      yield { searchEntries, searchReferences: [] };
    }
  },
};
vi.mock('./client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client.js')>()),
  withFailover: async (_config: unknown, fn: (c: unknown) => Promise<unknown>) => fn(fakeClient),
}));

const { ActiveDirectoryProvider } = await import('./provider.js');

const user = (n: number, extra: Record<string, unknown> = {}) => ({
  dn: `CN=u${n},DC=x`,
  distinguishedName: `CN=u${n},DC=x`,
  objectGUID: Buffer.from(n.toString(16).padStart(32, '0'), 'hex'),
  sAMAccountName: `u${n}`,
  userAccountControl: '512',
  ...extra,
});
const provider = () =>
  new ActiveDirectoryProvider({
    id: 1,
    name: 'test',
    baseDn: 'DC=x',
    ldapUrls: ['ldaps://dc'],
    tlsMode: 'ldaps',
    tlsRejectUnauthorized: true,
    operationTimeoutMs: 1000,
    serviceAccountUpn: 'svc@x',
    serviceAccountPassword: 'pw',
  });

beforeEach(() => {
  pagesFetched.count = 0;
});

describe('syncUsers', () => {
  it('yields entries as pages arrive instead of buffering the whole directory', async () => {
    pages = [0, 1, 2].map((p) => [user(p * 2 + 1), user(p * 2 + 2)]);
    const it = provider().syncUsers({ pageSize: 2 })[Symbol.asyncIterator]();
    const first = await it.next();

    expect(first.value?.samAccountName).toBe('u1');
    expect(pagesFetched.count).toBe(1);

    let rest = 0;
    for (let r = await it.next(); !r.done; r = await it.next()) rest++;
    expect(rest).toBe(5);
    expect(fakeClient.unbind).toHaveBeenCalled();
  });
});

describe('syncLockedUsers', () => {
  it('returns every account still locked, past any 500-result cap', async () => {
    // 900 users with a lockoutTime across 3 pages; every other one is still
    // locked per AD's computed bit, the rest have lapsed lockouts.
    pages = [0, 1, 2].map((p) =>
      Array.from({ length: 300 }, (_, i) => {
        const n = p * 300 + i;
        return user(n, {
          lockoutTime: '134371612642061100',
          'msDS-User-Account-Control-Computed': n % 2 === 0 ? '16' : '0',
        });
      }),
    );

    const locked: string[] = [];
    for await (const u of provider().syncLockedUsers()) locked.push(u.samAccountName!);

    expect(locked).toHaveLength(450);
    expect(locked.every((sam) => Number(sam.slice(1)) % 2 === 0)).toBe(true);
  });
});
