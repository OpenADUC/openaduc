// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Attribute, Change, Client as LdapClient } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DC,
  asAdministrator,
  configureDirectory,
  readDirectoryUser,
  reseedDirectory,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const ROOT = 'OU=OpenADUC Test,DC=openaduc,DC=test';
const WORKSTATIONS = `OU=Workstations,${ROOT}`;
const STAFF = `OU=Staff,${ROOT}`;
const WS01 = `CN=WS01,${WORKSTATIONS}`;
const WS02 = `CN=WS02,${WORKSTATIONS}`;
const DOMAIN_CONTROLLERS = 'OU=Domain Controllers,DC=openaduc,DC=test';

/** Put WS01 back where the fixtures have it, whatever a failed test left. */
const putWs01Back = () =>
  asAdministrator(async (client) => {
    await client.modifyDN(`CN=WS01,${STAFF}`, WS01).catch(() => undefined);
  });

/** Whether `password` signs WS01's machine account in, as a rejoining computer would. */
async function machineCanSignIn(password: string): Promise<boolean> {
  const client = new LdapClient({ url: DC.ldapsUrl, tlsOptions: { ca: readFileSync(DC.caPath) } });
  try {
    await client.bind(`WS01$@${DC.domain}`, password);
    return true;
  } catch {
    return false;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

describe('computer account writes', () => {
  let api: TestApi;
  let admin: TestClient;
  let operator: TestClient;
  let auditor: TestClient;
  let ws01: string;
  let ws02: string;

  const uac = async (sam: string) =>
    Number((await readDirectoryUser(sam, ['userAccountControl']))?.userAccountControl);
  const cached = (id: string) =>
    api.app.db
      .selectFrom('computer_cache_records')
      .select(['enabled', 'distinguished_name', 'password_last_set_at'])
      .where('object_guid', '=', id)
      .executeTakeFirstOrThrow();
  const auditRows = (action: string, id: string) =>
    api.app.db
      .selectFrom('audit_events')
      .select(['result', 'actor_display_name', 'target_dn', 'metadata_json'])
      .where('action', '=', action)
      .where('target_id', '=', id)
      .orderBy('id')
      .execute();
  const denials = async () =>
    (
      await api.app.db
        .selectFrom('audit_events')
        .select('metadata_json')
        .where('action', '=', 'authz.deny')
        .execute()
    ).map((r) => r.metadata_json);

  beforeAll(async () => {
    await putWs01Back();
    reseedDirectory();
    api = await startApi();
    admin = await configureDirectory(api);
    const rows = (await admin.get('/api/computers?q=WS0')).json<{
      rows: { id: string; name: string }[];
    }>().rows;
    ws01 = rows.find((r) => r.name === 'WS01')!.id;
    ws02 = rows.find((r) => r.name === 'WS02')!.id;
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
  });

  afterAll(async () => {
    await api?.close();
    await putWs01Back();
    reseedDirectory();
  });

  it('disables a computer, keeping its other userAccountControl bits', async () => {
    expect(await uac('WS01$')).toBe(0x1000);

    const res = await operator.post(`/api/computers/${ws01}/disable`);

    expect(res.statusCode).toBe(200);
    expect(await uac('WS01$')).toBe(0x1000 | 0x2);
    expect((await cached(ws01)).enabled).toBe(false);
    expect(await auditRows('computer.disable', ws01)).toEqual([
      expect.objectContaining({ result: 'success', actor_display_name: 'OpenADUC Operator' }),
    ]);
  });

  it('enables a disabled computer', async () => {
    expect(await uac('WS02$')).toBe(0x1000 | 0x2);

    const res = await operator.post(`/api/computers/${ws02}/enable`);

    expect(res.statusCode).toBe(200);
    expect(await uac('WS02$')).toBe(0x1000);
    expect((await cached(ws02)).enabled).toBe(true);
    expect(await auditRows('computer.enable', ws02)).toEqual([
      expect.objectContaining({ result: 'success' }),
    ]);
  });

  it('resets the account to the default machine password, as ADUC does', async () => {
    expect(
      (await operator.post(`/api/computers/${ws01}/enable`)).statusCode,
      'WS01 enabled again so it can sign in',
    ).toBe(200);
    // Give it a password other than the default, as a joined computer has.
    // Twice, since Samba also accepts a machine account's previous password.
    for (let i = 0; i < 2; i++) {
      await asAdministrator((client) =>
        client.modify(
          WS01,
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'unicodePwd',
              values: [Buffer.from(`"${randomUUID()}"`, 'utf16le')],
            }),
          }),
        ),
      );
    }
    const before = (await readDirectoryUser('WS01$', ['pwdLastSet']))?.pwdLastSet;
    expect(await machineCanSignIn('ws01')).toBe(false);

    const res = await operator.post(`/api/computers/${ws01}/reset-account`);

    expect(res.statusCode).toBe(200);
    const after = (await readDirectoryUser('WS01$', ['pwdLastSet']))?.pwdLastSet;
    expect(after).not.toBe(before);
    expect(await machineCanSignIn('ws01')).toBe(true);
    const row = await cached(ws01);
    expect(row.password_last_set_at).not.toBeNull();
    expect(await auditRows('computer.account.reset', ws01)).toEqual([
      expect.objectContaining({ result: 'success', target_dn: WS01 }),
    ]);
  });

  it('moves a computer to another OU and back', async () => {
    const away = await operator.post(`/api/computers/${ws01}/move`, { targetOuDn: STAFF });

    expect(away.statusCode).toBe(200);
    expect((await readDirectoryUser('WS01$', ['distinguishedName']))?.dn).toBe(`CN=WS01,${STAFF}`);
    expect((await cached(ws01)).distinguished_name).toBe(`CN=WS01,${STAFF}`);

    const back = await operator.post(`/api/computers/${ws01}/move`, { targetOuDn: WORKSTATIONS });

    expect(back.statusCode).toBe(200);
    expect((await readDirectoryUser('WS01$', ['distinguishedName']))?.dn).toBe(WS01);
    expect((await cached(ws01)).distinguished_name).toBe(WS01);
    expect(await auditRows('computer.move', ws01)).toEqual([
      expect.objectContaining({
        result: 'success',
        metadata_json: { targetOuDn: STAFF, targetOuName: 'Staff' },
      }),
      expect.objectContaining({ result: 'success', target_dn: `CN=WS01,${STAFF}` }),
    ]);
  });

  it('refuses a move to an OU the cache doesn’t know', async () => {
    const res = await operator.post(`/api/computers/${ws01}/move`, {
      targetOuDn: `OU=Nowhere,${ROOT}`,
    });

    expect(res.statusCode).toBe(400);
    expect((await readDirectoryUser('WS01$', ['distinguishedName']))?.dn).toBe(WS01);
  });

  it('says 404 for a computer that isn’t there', async () => {
    const res = await operator.post('/api/computers/00000000-0000-4000-8000-000000000000/disable');

    expect(res.statusCode).toBe(404);
  });

  it('refuses each action without its capability, and audits the denial', async () => {
    const results = await Promise.all([
      auditor.post(`/api/computers/${ws02}/disable`),
      auditor.post(`/api/computers/${ws02}/enable`),
      auditor.post(`/api/computers/${ws02}/reset-account`),
      auditor.post(`/api/computers/${ws02}/move`, { targetOuDn: STAFF }),
    ]);

    expect(results.map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);
    expect(await uac('WS02$')).toBe(0x1000);
    expect((await readDirectoryUser('WS02$', ['distinguishedName']))?.dn).toBe(WS02);
    expect(await denials()).toEqual(
      expect.arrayContaining([
        { requiredCapability: 'write:computer.enableDisable', route: '/api/computers/:id/disable' },
        { requiredCapability: 'write:computer.enableDisable', route: '/api/computers/:id/enable' },
        {
          requiredCapability: 'write:computer.resetAccount',
          route: '/api/computers/:id/reset-account',
        },
        { requiredCapability: 'write:computer.move', route: '/api/computers/:id/move' },
      ]),
    );
  });

  it('requires step-up for each action', async () => {
    const unelevated = api.client();
    await unelevated.signIn(api, 'oa.operator');
    const pwdLastSet = (await readDirectoryUser('WS02$', ['pwdLastSet']))?.pwdLastSet;

    const results = [
      await unelevated.post(`/api/computers/${ws02}/disable`),
      await unelevated.post(`/api/computers/${ws02}/enable`),
      await unelevated.post(`/api/computers/${ws02}/reset-account`),
      await unelevated.post(`/api/computers/${ws02}/move`, { targetOuDn: STAFF }),
    ];

    expect(results.map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);
    expect(results.map((r) => r.json<{ error: { code: string } }>().error.code)).toEqual(
      Array(4).fill('step_up_required'),
    );
    expect(await uac('WS02$')).toBe(0x1000);
    expect((await readDirectoryUser('WS02$', ['pwdLastSet']))?.pwdLastSet).toBe(pwdLastSet);
    expect((await readDirectoryUser('WS02$', ['distinguishedName']))?.dn).toBe(WS02);
  });

  describe('a domain controller', () => {
    let dc1: string;

    beforeAll(async () => {
      dc1 = (await admin.get('/api/computers?q=DC1'))
        .json<{
          rows: { id: string; name: string }[];
        }>()
        .rows.find((r) => r.name === 'DC1')!.id;
    });

    it('is marked so the UIs don’t offer the writes', async () => {
      const detail = await admin.get(`/api/computers/${dc1}`);
      const contents = await admin.get(
        `/api/ous/contents?dn=${encodeURIComponent(DOMAIN_CONTROLLERS)}`,
      );

      expect(detail.json<{ computer: { writeBlock: string } }>().computer.writeBlock).toBe(
        'domain_controller',
      );
      expect(
        contents
          .json<{ computers: { id: string; writeBlock: string | null }[] }>()
          .computers.find((c) => c.id === dc1)?.writeBlock,
      ).toBe('domain_controller');
      expect(
        (await operator.get(`/api/computers/${ws01}`)).json<{
          computer: { writeBlock: string | null };
        }>().computer.writeBlock,
      ).toBeNull();
    });

    it('can’t be disabled, reset or moved, even by a Domain Admin, and the refusal is audited', async () => {
      const before = await readDirectoryUser('DC1$', ['userAccountControl', 'pwdLastSet']);

      const results = [
        await admin.post(`/api/computers/${dc1}/disable`),
        await admin.post(`/api/computers/${dc1}/reset-account`),
        await admin.post(`/api/computers/${dc1}/move`, { targetOuDn: STAFF }),
      ];

      expect(results.map((r) => r.statusCode)).toEqual([409, 409, 409]);
      for (const r of results) {
        expect(r.json<{ error: { message: string } }>().error.message).toContain(
          'this is a domain controller',
        );
      }
      const after = await readDirectoryUser('DC1$', ['userAccountControl', 'pwdLastSet']);
      expect(after).toEqual(before);
      expect(after?.dn).toBe(`CN=DC1,${DOMAIN_CONTROLLERS}`);
      for (const action of ['computer.disable', 'computer.account.reset', 'computer.move']) {
        expect(await auditRows(action, dc1), action).toEqual([
          expect.objectContaining({
            result: 'failure',
            metadata_json: expect.objectContaining({ blockedReason: 'domain_controller' }),
          }),
        ]);
      }
    });
  });
});
