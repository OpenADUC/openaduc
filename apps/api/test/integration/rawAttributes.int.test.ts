// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, startApi, type TestApi, type TestClient } from './harness.js';

// The fields the UI shows as ordinary properties for any reader.
const PROFILE_ATTRS = new Set([
  'facsimileTelephoneNumber',
  'homeDirectory',
  'info',
  'location',
  'machineRole',
  'msDS-SiteName',
  'operatingSystemServicePack',
  'pager',
  'physicalDeliveryOfficeName',
  'postOfficeBox',
  'profilePath',
  'scriptPath',
]);

describe('raw directory attributes', () => {
  let api: TestApi;
  let admin: TestClient;
  let auditor: TestClient;

  beforeAll(async () => {
    api = await startApi();
    admin = await configureDirectory(api);
    auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
  });
  afterAll(async () => {
    await api?.close();
  });

  const rawOf = async (client: TestClient, kind: 'users' | 'computers', q: string) => {
    const list = await client.get(`/api/${kind}?q=${q}`);
    const id = list.json<{ rows: { id: string }[] }>().rows[0]!.id;
    const detail = await client.get(`/api/${kind}/${id}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json<Record<string, { rawAttributes: Record<string, unknown> }>>();
    return (kind === 'users' ? body.user : body.computer)!.rawAttributes;
  };

  it('are withheld from a reader without view:raw_attributes, beyond profile fields', async () => {
    for (const [kind, q] of [
      ['users', 'alice'],
      ['computers', 'WS01'],
    ] as const) {
      const keys = Object.keys(await rawOf(auditor, kind, q));
      expect(keys.filter((k) => !PROFILE_ATTRS.has(k))).toEqual([]);
    }
  });

  it('are returned in full to an admin', async () => {
    const raw = await rawOf(admin, 'computers', 'WS01');
    expect(raw).toHaveProperty('whenCreated');
    expect(raw).toHaveProperty('objectClass');
  });
});
