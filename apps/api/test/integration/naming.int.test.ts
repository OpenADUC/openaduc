// SPDX-License-Identifier: BUSL-1.1
import type {
  NamingCheckResponse,
  NamingSettingsResponse,
  NamingSuggestion,
} from '@openaduc/shared';
import { Attribute, Change } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAdministrator,
  configureDirectory,
  DC,
  readDirectoryUser,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const EXTRA_SUFFIX = 'naming-test.openaduc.test';
const PARTITIONS = 'CN=Partitions,CN=Configuration,DC=openaduc,DC=test';

async function setExtraSuffix(present: boolean): Promise<void> {
  await asAdministrator(async (client) => {
    try {
      await client.modify(
        PARTITIONS,
        new Change({
          operation: present ? 'add' : 'delete',
          modification: new Attribute({ type: 'uPNSuffixes', values: [EXTRA_SUFFIX] }),
        }),
      );
    } catch (err) {
      const name = (err as Error).name;
      if (name !== 'AttributeOrValueExistsError' && name !== 'NoSuchAttributeError') throw err;
    }
  });
}

describe('naming pattern', () => {
  let api: TestApi;
  let admin: TestClient;
  let operator: TestClient;
  let url: string;
  let staffOu: string;

  beforeAll(async () => {
    await setExtraSuffix(true);
    api = await startApi();
    admin = await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    url = `/api/directories/${api.directoryId}/naming`;

    const alice = await readDirectoryUser('alice.anders', ['cn']);
    expect(alice?.cn).toBe('Alice Anders');
    const dn = String(alice!.dn);
    staffOu = dn.slice(dn.indexOf(',') + 1);
  });
  afterAll(async () => {
    await api?.close();
    await setExtraSuffix(false);
  });

  async function check(
    client: TestClient,
    names: Record<string, string>[],
  ): Promise<NamingSuggestion[]> {
    const res = await client.post(`${url}/check`, { names });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<NamingCheckResponse>().suggestions;
  }

  it('starts at {first}.{last} on the domain, offering the forest’s UPN suffixes', async () => {
    const res = await operator.get(url);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<NamingSettingsResponse>()).toEqual({
      naming: { pattern: '{first}.{last}', upnSuffix: DC.domain },
      upnSuffixes: [DC.domain, EXTRA_SUFFIX],
    });
  });

  it('suffixes a name already held in the directory', async () => {
    const [alice] = await check(operator, [{ first: 'Alice', last: 'Anders' }]);
    expect(alice).toMatchObject({
      samAccountName: 'alice.anders2',
      upn: `alice.anders2@${DC.domain}`,
      mail: `alice.anders2@${DC.domain}`,
    });
    expect(alice!.deviations).toEqual([
      expect.objectContaining({
        kind: 'collision',
        source: 'directory',
        taken: ['samAccountName', 'userPrincipalName', 'mail'],
        suffix: 2,
      }),
    ]);
  });

  it('suffixes the second of two new people with one name', async () => {
    const results = await check(operator, [
      { first: 'Zed', last: 'Quinn' },
      { first: 'Zed', last: 'Quinn' },
    ]);
    expect(results.map((s) => s.samAccountName)).toEqual(['zed.quinn', 'zed.quinn2']);
    expect(results[1]!.deviations).toEqual([
      expect.objectContaining({ kind: 'collision', source: 'batch' }),
    ]);
  });

  it('renames a CN that collides in the target OU only', async () => {
    const [staff, elsewhere] = await check(operator, [
      { first: 'Alice', last: 'Anders', ouDn: staffOu },
      {
        first: 'Alice',
        last: 'Anders',
        ouDn: `OU=Contractors,${staffOu.slice(staffOu.indexOf(',') + 1)}`,
      },
    ]);
    expect(staff).toMatchObject({
      cn: 'Alice Anders (alice.anders2)',
      displayName: 'Alice Anders',
    });
    expect(staff!.deviations.at(-1)).toMatchObject({ kind: 'cn_collision', source: 'directory' });
    expect(elsewhere).toMatchObject({ samAccountName: 'alice.anders3', cn: 'Alice Anders' });
  });

  it('blocks a CN whose bracketed fallback is taken in the OU too', async () => {
    const fallbackDn = `CN=Alice Anders (alice.anders2),${staffOu}`;
    await asAdministrator((client) =>
      client.add(fallbackDn, {
        objectClass: ['top', 'contact'],
        cn: 'Alice Anders (alice.anders2)',
      }),
    );
    try {
      const [staff] = await check(operator, [{ first: 'Alice', last: 'Anders', ouDn: staffOu }]);
      expect(staff!.deviations.at(-1)).toMatchObject({
        kind: 'cn_collision',
        approval: 'blocked',
      });
    } finally {
      await asAdministrator((client) => client.del(fallbackDn));
    }
  });

  it('accepts a container under the base DN, and refuses any other OU', async () => {
    const [users] = await check(operator, [
      { first: 'Zed', last: 'Quinn', ouDn: `CN=Users,${DC.baseDn}` },
    ]);
    expect(users!.cn).toBe('Zed Quinn');

    for (const ouDn of ['not a dn', 'OU=Staff,DC=elsewhere,DC=test', 'OU=Staff\\']) {
      const res = await operator.post(`${url}/check`, {
        names: [{ first: 'Zed', last: 'Quinn', ouDn }],
      });
      expect(res.statusCode, ouDn).toBe(400);
    }
  });

  it('is refused to an operator, and to a pattern or suffix that cannot work', async () => {
    const body = { pattern: '{f}{last}', upnSuffix: EXTRA_SUFFIX };
    expect((await operator.put(url, body)).statusCode).toBe(403);

    const badPattern = await admin.put(url, { ...body, pattern: '{first}.{surname}' });
    expect(badPattern.statusCode).toBe(400);
    expect(badPattern.json<{ error: { message: string } }>().error.message).toMatch(/\{surname\}/);

    const badSuffix = await admin.put(url, { ...body, upnSuffix: 'elsewhere.example' });
    expect(badSuffix.statusCode).toBe(400);
  });

  it('saves the pattern and suffix, audits the change and names new accounts by them', async () => {
    const res = await admin.put(url, { pattern: '{f}{last}', upnSuffix: EXTRA_SUFFIX });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<NamingSettingsResponse>().naming).toEqual({
      pattern: '{f}{last}',
      upnSuffix: EXTRA_SUFFIX,
    });

    const event = await api.app.db
      .selectFrom('audit_events')
      .select(['before_json', 'after_json', 'result'])
      .where('action', '=', 'directory.naming.update')
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      result: 'success',
      before_json: { pattern: '{first}.{last}', upnSuffix: DC.domain },
      after_json: { pattern: '{f}{last}', upnSuffix: EXTRA_SUFFIX },
    });

    const [s] = await check(operator, [{ first: 'Alice', last: 'Anders' }]);
    expect(s).toMatchObject({ samAccountName: 'aanders', upn: `aanders@${EXTRA_SUFFIX}` });
  });
});
