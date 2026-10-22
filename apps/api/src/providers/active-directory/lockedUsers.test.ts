// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from 'vitest';

// 900 users with a lockoutTime across 3 pages; every other one is still
// locked per AD's computed bit, the rest have lapsed lockouts.
const entry = (n: number) => ({
  dn: `CN=u${n},DC=x`,
  distinguishedName: `CN=u${n},DC=x`,
  objectGUID: Buffer.from(n.toString(16).padStart(32, '0'), 'hex'),
  sAMAccountName: `u${n}`,
  userAccountControl: '512',
  lockoutTime: '134371612642061100',
  'msDS-User-Account-Control-Computed': n % 2 === 0 ? '16' : '0',
});
const page = (p: number) => Array.from({ length: 300 }, (_, i) => entry(p * 300 + i));
// Both the paged-generator and the all-at-once search APIs, whichever the
// provider uses.
const fakeClient = {
  bind: vi.fn(async () => {}),
  unbind: vi.fn(async () => {}),
  async *searchPaginated() {
    for (let p = 0; p < 3; p++) yield { searchEntries: page(p), searchReferences: [] };
  },
  async search() {
    return { searchEntries: [0, 1, 2].flatMap(page), searchReferences: [] };
  },
};
vi.mock('./client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client.js')>()),
  withFailover: async (_config: unknown, fn: (c: unknown) => Promise<unknown>) => fn(fakeClient),
}));

const { ActiveDirectoryProvider } = await import('./provider.js');

describe('syncLockedUsers', () => {
  it('returns every account still locked, past any 500-result cap', async () => {
    const provider = new ActiveDirectoryProvider({
      id: 1,
      name: 'test',
      baseDn: 'DC=x',
      ldapUrls: ['ldaps://dc'],
      tlsRejectUnauthorized: true,
      operationTimeoutMs: 1000,
      serviceAccountUpn: 'svc@x',
      serviceAccountPassword: 'pw',
    } as ConstructorParameters<typeof ActiveDirectoryProvider>[0]);

    const locked: string[] = [];
    for await (const u of provider.syncLockedUsers()) locked.push(u.samAccountName!);

    expect(locked).toHaveLength(450);
    expect(locked.every((sam) => Number(sam.slice(1)) % 2 === 0)).toBe(true);
  });
});
