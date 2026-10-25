// SPDX-License-Identifier: BUSL-1.1
// The usage location an import writes, against a fake LDAP connection:
// the dev DC's schema has no msExchUsageLocation, so it can't show it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SCHEMA_NC = 'CN=Schema,CN=Configuration,DC=corp,DC=test';
let schemaHas: string[] = [];
const adds: { dn: string; attrs: Record<string, unknown> }[] = [];
const client = {
  bind: vi.fn(async () => undefined),
  unbind: vi.fn(async () => undefined),
  add: vi.fn(async (dn: string, attrs: Record<string, unknown>) => {
    adds.push({ dn, attrs });
  }),
  modify: vi.fn(async () => undefined),
  search: vi.fn(async (base: string, opts: { filter?: string }) => {
    if (base === '') return { searchEntries: [{ dn: '', schemaNamingContext: SCHEMA_NC }] };
    if (base === SCHEMA_NC) {
      const name = /lDAPDisplayName=([^)]+)/.exec(opts.filter ?? '')?.[1];
      return {
        searchEntries: name && schemaHas.includes(name) ? [{ dn: `CN=${name},${SCHEMA_NC}` }] : [],
      };
    }
    return { searchEntries: [] };
  }),
};
vi.mock('./client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client.js')>()),
  withFailover: async (_config: unknown, fn: (c: typeof client) => Promise<unknown>) => fn(client),
}));

const { ActiveDirectoryProvider } = await import('./provider.js');

let directoryId = 100;
const provider = () =>
  new ActiveDirectoryProvider({
    id: ++directoryId,
    name: 'corp',
    baseDn: 'DC=corp,DC=test',
    ldapUrls: ['ldaps://dc1.corp.test'],
    tlsMode: 'ldaps',
    tlsRejectUnauthorized: true,
    operationTimeoutMs: 5_000,
    serviceAccountUpn: 'svc@corp.test',
    serviceAccountPassword: 'secret',
  });
const ctx = {
  actorUserId: 'u1',
  actorUsername: 'op@corp.test',
  actorPassword: 'pw',
  correlationId: 'c1',
};
const input = (usageLocation: string | null) => ({
  dn: 'CN=Jane Doe,OU=Staff,DC=corp,DC=test',
  cn: 'Jane Doe',
  samAccountName: 'jane.doe',
  userPrincipalName: 'jane.doe@corp.test',
  givenName: 'Jane',
  surname: 'Doe',
  displayName: 'Jane Doe',
  mail: null,
  otherMailbox: null,
  mobile: null,
  telephoneNumber: null,
  organisation: {},
  manager: null,
  usageLocation,
});

describe('a new account’s usage location', () => {
  beforeEach(() => {
    adds.length = 0;
    schemaHas = [];
  });

  it('is in the add entry where the schema has msExchUsageLocation', async () => {
    schemaHas = ['msExchUsageLocation'];
    const ad = provider();
    expect(await ad.hasSchemaAttribute('msExchUsageLocation')).toBe(true);
    const created = await ad.createUser(
      input('DE'),
      ['create'],
      { password: '', mustChange: false, groups: [] },
      ctx,
    );
    expect(created.completed).toEqual(['create']);
    expect(adds).toEqual([
      {
        dn: 'CN=Jane Doe,OU=Staff,DC=corp,DC=test',
        attrs: expect.objectContaining({ sAMAccountName: 'jane.doe', msExchUsageLocation: 'DE' }),
      },
    ]);
  });

  it('isn’t written without one, and the schema is asked once an hour', async () => {
    const ad = provider();
    expect(await ad.hasSchemaAttribute('msExchUsageLocation')).toBe(false);
    schemaHas = ['msExchUsageLocation'];
    expect(await ad.hasSchemaAttribute('msExchUsageLocation')).toBe(false);
    await ad.createUser(
      input(null),
      ['create'],
      { password: '', mustChange: false, groups: [] },
      ctx,
    );
    expect(adds[0]?.attrs).not.toHaveProperty('msExchUsageLocation');
  });
});
