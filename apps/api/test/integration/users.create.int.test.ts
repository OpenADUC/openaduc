// SPDX-License-Identifier: BUSL-1.1
import { readFileSync } from 'node:fs';
import type { UserCreateRequest, UserCreateResponse } from '@openaduc/shared';
import { Client as LdapClient } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DC,
  asAdministrator,
  configureDirectory,
  readDirectoryUser,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const STAFF_OU = 'OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test';
const PASSWORD = 'Brand-new-Start9';
const NEW_SAMS = ['nina.novak', 'omar.ortiz', 'pia.park', 'quinn.quade', 'rosa.reyes', 'sam.stone'];

/** A create request for someone new in Staff, with what's given replacing the defaults. */
function person(sam: string, over: Partial<UserCreateRequest> = {}): UserCreateRequest {
  const [first, last] = sam.split('.').map((p) => p[0]!.toUpperCase() + p.slice(1)) as [
    string,
    string,
  ];
  return {
    ouDn: STAFF_OU,
    givenName: first,
    surname: last,
    displayName: `${first} ${last}`,
    cn: `${first} ${last}`,
    samAccountName: sam,
    userPrincipalName: `${sam}@${DC.domain}`,
    mailFromUpn: true,
    password: { mode: 'random' },
    enabled: true,
    ...over,
  };
}

const UAC_DISABLED = 0x2;
const ATTRS = [
  'userAccountControl',
  'pwdLastSet',
  'mail',
  'otherMailbox',
  'mobile',
  'telephoneNumber',
  'userPrincipalName',
  'givenName',
  'sn',
  'displayName',
  'proxyAddresses',
];
const directoryUser = (sam: string) => readDirectoryUser(sam, ATTRS);
const disabled = (entry: Record<string, unknown> | null) =>
  (Number(entry?.userAccountControl) & UAC_DISABLED) !== 0;

async function canBind(upn: string, password: string): Promise<boolean> {
  const client = new LdapClient({ url: DC.ldapsUrl, tlsOptions: { ca: readFileSync(DC.caPath) } });
  try {
    await client.bind(upn, password);
    return true;
  } catch {
    return false;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

const removeNewUsers = () =>
  asAdministrator(async (client) => {
    for (const sam of NEW_SAMS) {
      const { searchEntries } = await client.search(DC.baseDn, {
        scope: 'sub',
        filter: `(sAMAccountName=${sam})`,
        attributes: ['distinguishedName'],
      });
      for (const e of searchEntries) await client.del(e.dn).catch(() => undefined);
    }
  });

describe('creating users', () => {
  let api: TestApi;
  let operator: TestClient;

  const create = (body: UserCreateRequest) => operator.post('/api/users', body);
  const auditRows = (action: string) =>
    api.app.db
      .selectFrom('audit_events')
      .select(['result', 'target_id', 'target_dn', 'metadata_json', 'after_json', 'error_code'])
      .where('action', '=', action)
      .orderBy('id')
      .execute();

  beforeAll(async () => {
    await removeNewUsers();
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
  });

  afterAll(async () => {
    await api?.close();
    await removeNewUsers();
  });

  it('creates an enabled user with a random password nobody sees, and lists it at once', async () => {
    const res = await create(
      person('nina.novak', {
        personalEmail: 'nina@example.org',
        mobile: '+44 7400123456',
        telephoneNumber: '+44 2079460958',
      }),
    );

    expect(res.statusCode, res.body).toBe(200);
    const created = res.json<UserCreateResponse>();
    expect(created).toMatchObject({
      distinguishedName: `CN=Nina Novak,${STAFF_OU}`,
      samAccountName: 'nina.novak',
      completed: ['create', 'password', 'enable'],
      remaining: [],
      failure: null,
    });
    expect(Object.keys(created).sort()).toEqual(
      ['completed', 'distinguishedName', 'failure', 'id', 'remaining', 'samAccountName'].sort(),
    );
    const entry = await directoryUser('nina.novak');
    expect(entry).toMatchObject({
      userPrincipalName: `nina.novak@${DC.domain}`,
      mail: `nina.novak@${DC.domain}`,
      otherMailbox: 'nina@example.org',
      mobile: '+44 7400123456',
      telephoneNumber: '+44 2079460958',
      givenName: 'Nina',
      sn: 'Novak',
      displayName: 'Nina Novak',
    });
    expect(entry?.proxyAddresses).toEqual([]);
    expect(disabled(entry)).toBe(false);
    // Set, and not "must change": a synced user couldn't sign in to Entra.
    expect(Number(entry?.pwdLastSet)).toBeGreaterThan(0);

    const listed = await operator.get('/api/users?q=nina.novak');
    expect(listed.json<{ rows: { id: string }[] }>().rows.map((r) => r.id)).toEqual([created.id]);
    const contents = await operator.get(`/api/ous/contents?dn=${encodeURIComponent(STAFF_OU)}`);
    expect(contents.json<{ users: { id: string }[] }>().users.map((u) => u.id)).toContain(
      created.id,
    );

    const [row] = await auditRows('user.create');
    expect(row).toMatchObject({
      result: 'success',
      target_id: created.id,
      target_dn: `CN=Nina Novak,${STAFF_OU}`,
      metadata_json: expect.objectContaining({ passwordMode: 'random', mustChange: false }),
      after_json: expect.objectContaining({
        completed: ['create', 'password', 'enable'],
        remaining: [],
      }),
    });
    const all = await api.app.db
      .selectFrom('audit_events')
      .select(['metadata_json', 'after_json', 'before_json'])
      .where('target_id', '=', created.id)
      .execute();
    expect(JSON.stringify(all)).not.toMatch(/password"\s*:/i);
  });

  it('sets a typed password, which the new user signs in with', async () => {
    const res = await create(
      person('omar.ortiz', { password: { mode: 'set', password: PASSWORD, mustChange: false } }),
    );

    expect(res.json<UserCreateResponse>().remaining).toEqual([]);
    expect(await canBind(`omar.ortiz@${DC.domain}`, PASSWORD)).toBe(true);
  });

  it('sets a generated password the user must change, and leaves mail alone when asked', async () => {
    const res = await create(
      person('pia.park', {
        mailFromUpn: false,
        password: { mode: 'generate', password: 'Gen3rated-Pass!x', mustChange: true },
      }),
    );

    expect(res.json<UserCreateResponse>().remaining).toEqual([]);
    const entry = await directoryUser('pia.park');
    expect(entry?.pwdLastSet).toBe('0');
    expect(entry?.mail).toEqual([]);
    expect(disabled(entry)).toBe(false);
    const [, , row] = await auditRows('user.create');
    expect(row?.metadata_json).toMatchObject({ passwordMode: 'generate', mustChange: true });
  });

  it('leaves the account disabled when asked to', async () => {
    const res = await create(person('quinn.quade', { enabled: false }));

    expect(res.json<UserCreateResponse>()).toMatchObject({
      completed: ['create', 'password'],
      remaining: [],
    });
    expect(disabled(await directoryUser('quinn.quade'))).toBe(true);
  });

  it('refuses names already taken, saying by whom, and writes nothing', async () => {
    const sam = await create(person('rosa.reyes', { samAccountName: 'alice.anders' }));
    const cn = await create(person('rosa.reyes', { cn: 'Alice Anders' }));

    expect([sam.statusCode, cn.statusCode]).toEqual([409, 409]);
    expect(sam.json<{ error: { message: string } }>().error.message).toContain(
      'logon name "alice.anders"',
    );
    expect(cn.json<{ error: { message: string } }>().error.message).toContain(
      `CN=Alice Anders,${STAFF_OU}`,
    );
    expect(await directoryUser('rosa.reyes')).toBeNull();
    const failed = (await auditRows('user.create')).filter((r) => r.result === 'failure');
    expect(failed.map((r) => r.error_code)).toEqual(['conflict', 'conflict']);
  });

  it('refuses names the naming check would block, and an OU it doesn’t know', async () => {
    const suffix = await create(
      person('rosa.reyes', { userPrincipalName: 'rosa@nowhere.example' }),
    );
    const sam = await create(person('rosa.reyes', { samAccountName: 'rosa.reyes.the.second.one' }));
    const ou = await create(person('rosa.reyes', { ouDn: 'OU=Nowhere,DC=openaduc,DC=test' }));

    expect([suffix.statusCode, sam.statusCode, ou.statusCode]).toEqual([400, 400, 400]);
    expect(suffix.json<{ error: { message: string } }>().error.message).toContain('UPN suffixes');
    expect(await directoryUser('rosa.reyes')).toBeNull();
  });

  describe('a failure part-way', () => {
    let id: string;

    it('leaves the account disabled, and says what remains', async () => {
      const res = await create(
        person('sam.stone', {
          password: { mode: 'set', password: 'alllowercase', mustChange: true },
        }),
      );

      expect(res.statusCode, res.body).toBe(200);
      const created = res.json<UserCreateResponse>();
      expect(created).toMatchObject({
        completed: ['create'],
        remaining: ['password', 'enable'],
        failure: { step: 'password', message: expect.any(String) },
      });
      id = created.id!;
      expect(disabled(await directoryUser('sam.stone'))).toBe(true);
      expect((await operator.get(`/api/users/${id}`)).statusCode).toBe(200);
      const row = (await auditRows('user.create')).at(-1);
      expect(row).toMatchObject({
        result: 'failure',
        error_code: 'policy_violation',
        target_id: id,
        after_json: expect.objectContaining({
          completed: ['create'],
          remaining: ['password', 'enable'],
        }),
      });
    });

    it('needs a password to finish when the password is left', async () => {
      const res = await operator.post(`/api/users/${id}/finish-create`, { enabled: true });
      expect(res.statusCode).toBe(400);
    });

    it('finishes the remaining steps on the same account', async () => {
      const res = await operator.post(`/api/users/${id}/finish-create`, {
        password: { mode: 'set', password: PASSWORD, mustChange: false },
        enabled: true,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<UserCreateResponse>()).toMatchObject({
        id,
        completed: ['create', 'password', 'enable'],
        remaining: [],
        failure: null,
      });
      expect(disabled(await directoryUser('sam.stone'))).toBe(false);
      expect(await canBind(`sam.stone@${DC.domain}`, PASSWORD)).toBe(true);
      const listed = await operator.get('/api/users?q=sam.stone');
      expect(listed.json<{ rows: { enabled: boolean }[] }>().rows).toEqual([
        expect.objectContaining({ enabled: true }),
      ]);
      expect((await auditRows('user.create.finish')).at(-1)).toMatchObject({
        result: 'success',
        target_id: id,
        metadata_json: { steps: ['password', 'enable'], passwordMode: 'set', mustChange: false },
      });
    });

    it('has nothing left to finish afterwards, nor on an account it didn’t create', async () => {
      const alice = (await operator.get('/api/users?q=alice.anders')).json<{
        rows: { id: string }[];
      }>().rows[0]!.id;
      const body = { password: { mode: 'random' }, enabled: true };

      expect((await operator.post(`/api/users/${id}/finish-create`, body)).statusCode).toBe(409);
      expect((await operator.post(`/api/users/${alice}/finish-create`, body)).statusCode).toBe(409);
    });
  });

  it('is refused to an auditor, and needs step-up', async () => {
    const auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    const refused = await auditor.post('/api/users', person('rosa.reyes'));
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).not.toBe('step_up_required');

    const unelevated = api.client();
    await unelevated.signIn(api, 'oa.operator');
    const res = await unelevated.post('/api/users', person('rosa.reyes'));
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
    expect(await directoryUser('rosa.reyes')).toBeNull();
  });
});
