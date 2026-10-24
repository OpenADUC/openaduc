// SPDX-License-Identifier: BUSL-1.1
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TapPreflight } from '@openaduc/shared';
import { ActiveDirectoryProvider } from '../../src/providers/active-directory/provider.js';
import { json, token } from './fakeGraph.js';
import { configureDirectory, DC, startApi, type TestApi, type TestClient } from './harness.js';

// Issue TAP against the dev DC, with Microsoft Graph played by a fake
// behind fetch: the API's own Graph client, token and all, talks to it.

const GROUPS = 'OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test';
const PASS = 'Tap-Value-7Kq2';
const ALL_PERMISSIONS = [
  'UserAuthMethod-TAP.ReadWrite.All',
  'Policy.Read.AuthenticationMethod',
  'User.Read.All',
  'RoleManagement.Read.Directory',
  'Organization.Read.All',
];

interface FakeTap {
  createdDateTime: string;
  startDateTime: string;
  lifetimeInMinutes: number;
  isUsableOnce: boolean;
  isUsable: boolean;
  methodUsabilityReason: string;
}

/** Microsoft Graph as far as Issue TAP and the connection test use it. */
class FakeGraph {
  roles = [...ALL_PERMISSIONS];
  policy = {
    state: 'enabled',
    defaultLifetimeInMinutes: 60,
    minimumLifetimeInMinutes: 60,
    maximumLifetimeInMinutes: 480,
    isUsableOnce: false,
    includeTargets: [{ targetType: 'group', id: 'all_users' }],
  };
  /** Principals holding an Entra role. */
  roleHolders: string[] = [];
  /** Graph's answer to the next pass created, instead of creating it. */
  rejectNextPass: string | null = null;
  /** AD objectSid → Entra object id, for the users Connect Sync has synced. */
  synced = new Map<string, string>();
  passes = new Map<string, FakeTap[]>();
  requests: { method: string; url: string; body: string | null }[] = [];

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    this.requests.push({ method, url: url.toString(), body: (init.body as string) ?? null });
    if (url.hostname === 'login.microsoftonline.com') {
      return json({ access_token: token(this.roles), expires_in: 3600 });
    }
    const path = url.pathname.replace(/^\/v1\.0/, '');
    if (path === '/organization') {
      return json({
        value: [{ displayName: 'Test Tenant', onPremisesLastSyncDateTime: '2026-10-24T11:30:00Z' }],
      });
    }
    if (path.endsWith('/authenticationMethodConfigurations/TemporaryAccessPass')) {
      return json({ id: 'TemporaryAccessPass', ...this.policy });
    }
    if (path === '/users') {
      const sid = /onPremisesSecurityIdentifier eq '([^']+)'/.exec(
        url.searchParams.get('$filter') ?? '',
      )?.[1];
      const id = sid ? this.synced.get(sid) : undefined;
      return json({ value: id ? [{ id }] : [] });
    }
    const passes = /^\/users\/([^/]+)\/authentication\/temporaryAccessPassMethods$/.exec(path);
    if (passes) {
      const id = decodeURIComponent(passes[1]!);
      if (method === 'GET') return json({ value: this.passes.get(id) ?? [] });
      if (this.rejectNextPass) {
        const message = this.rejectNextPass;
        this.rejectNextPass = null;
        return json({ error: { code: 'badRequest', message } }, 400);
      }
      const body = JSON.parse(String(init.body)) as {
        startDateTime?: string;
        lifetimeInMinutes: number;
        isUsableOnce: boolean;
      };
      const created: FakeTap = {
        createdDateTime: new Date().toISOString(),
        startDateTime: body.startDateTime ?? new Date().toISOString(),
        lifetimeInMinutes: body.lifetimeInMinutes,
        isUsableOnce: body.isUsableOnce,
        isUsable: true,
        methodUsabilityReason: 'EnabledByPolicy',
      };
      this.passes.set(id, [created]);
      return json({ id: 'tap', temporaryAccessPass: PASS, ...created }, 201);
    }
    if (path.startsWith('/roleManagement/directory/')) {
      return json({ value: this.roleHolders.map((principalId) => ({ principalId })) });
    }
    if (/^\/users\/[^/]+\/transitiveMemberOf$/.test(path)) {
      return json({ value: [{ '@odata.type': '#microsoft.graph.group', id: 'g1' }] });
    }
    return json({ error: { code: 'Request_ResourceNotFound', message: path } }, 404);
  };
}

describe('Issue TAP', () => {
  let api: TestApi;
  let admin: TestClient;
  let operator: TestClient;
  let graph: FakeGraph;
  const users: Record<string, { id: string; sid: string }> = {};

  const preflight = async (client: TestClient, who: string) => {
    const res = await client.get(`/api/users/${users[who]!.id}/temporary-access-pass`);
    return { res, body: res.json<TapPreflight>() };
  };
  const issue = (client: TestClient, who: string, body: Record<string, unknown> = {}) =>
    client.post(`/api/users/${users[who]!.id}/temporary-access-pass`, {
      startsAt: null,
      lifetimeMinutes: 120,
      isUsableOnce: true,
      ...body,
    });
  const entraIdOf = (who: string) => `entra-${who}`;

  beforeAll(async () => {
    api = await startApi();
    admin = await configureDirectory(api);
    await api.app.services.entraIntegration.create(api.directoryId!, {
      tenantId: '11111111-2222-4333-8444-555555555555',
      clientId: 'client',
      clientSecret: 'not-a-real-secret',
      features: { temporaryAccessPass: true },
    });
    const rows = await api.app.db
      .selectFrom('user_cache_records')
      .select(['object_guid', 'sid', 'sam_account_name'])
      .where('provider_id', '=', api.directoryId!)
      .where('sam_account_name', 'in', ['alice.anders', 'bob.baker', 'oa.admin'])
      .execute();
    for (const r of rows) users[r.sam_account_name!] = { id: r.object_guid, sid: r.sid! };

    operator = api.client();
    await operator.signIn(api, 'oa.operator');
  });
  beforeEach(() => {
    graph = new FakeGraph();
    for (const who of ['alice.anders', 'oa.admin']) {
      graph.synced.set(users[who]!.sid, entraIdOf(who));
    }
    vi.stubGlobal('fetch', graph.fetch);
    api.app.services.graphClient.invalidateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await api?.close();
  });

  it('is offered on the user’s page', async () => {
    const res = await operator.get(`/api/users/${users['alice.anders']!.id}`);
    expect(res.json()).toMatchObject({ user: { entra: { temporaryAccessPass: true } } });
  });

  it('reads the tenant policy’s limits for a synced user', async () => {
    const { res, body } = await preflight(operator, 'alice.anders');
    expect(res.statusCode).toBe(200);
    expect(body).toEqual({
      status: 'ready',
      policy: {
        defaultLifetimeMinutes: 60,
        minLifetimeMinutes: 60,
        maxLifetimeMinutes: 480,
        usableOnceOnly: false,
      },
      existing: null,
      inPolicyScope: true,
    });
  });

  it('issues a pass after step-up, returns its value once and audits it without the value', async () => {
    expect((await issue(operator, 'alice.anders')).json()).toMatchObject({
      error: { code: 'step_up_required' },
    });
    await operator.stepUp();

    const res = await issue(operator, 'alice.anders');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      temporaryAccessPass: PASS,
      lifetimeMinutes: 120,
      isUsableOnce: true,
      replaced: false,
    });
    const post = graph.requests.find((r) => r.method === 'POST' && r.url.includes('/users/'));
    expect(JSON.parse(post!.body!)).toEqual({ lifetimeInMinutes: 120, isUsableOnce: true });

    const event = await api.app.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'user.tap.issue')
      .where('result', '=', 'success')
      .executeTakeFirstOrThrow();
    expect(event.target_id).toBe(users['alice.anders']!.id);
    expect(event.after_json).toMatchObject({ entraUserId: entraIdOf('alice.anders') });
    expect(JSON.stringify(event)).not.toContain(PASS);
  });

  it('warns before replacing the pass the user holds', async () => {
    await operator.stepUp();
    expect((await issue(operator, 'alice.anders')).statusCode).toBe(200);

    const { body } = await preflight(operator, 'alice.anders');
    expect(body).toMatchObject({ status: 'ready', existing: { lifetimeMinutes: 120 } });

    const unwarned = await issue(operator, 'alice.anders');
    expect(unwarned.statusCode).toBe(409);
    expect(unwarned.json()).toMatchObject({
      error: { code: 'tap_exists', details: { existing: { lifetimeMinutes: 120 } } },
    });

    const replaced = await issue(operator, 'alice.anders', { replaceExisting: true });
    expect(replaced.json()).toMatchObject({ replaced: true });
  });

  it('holds to the tenant policy’s lifetime range and one-time setting', async () => {
    await operator.stepUp();
    graph.policy.isUsableOnce = true;
    const tooLong = await issue(operator, 'alice.anders', { lifetimeMinutes: 600 });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: { code: 'outside_policy' } });
    const multiUse = await issue(operator, 'alice.anders', { isUsableOnce: false });
    expect(multiUse.json()).toMatchObject({ error: { code: 'outside_policy' } });
    expect(graph.requests.some((r) => r.method === 'POST' && r.url.includes('/users/'))).toBe(
      false,
    );
  });

  it('refuses a Domain Admin, with the reason, and audits the refusal', async () => {
    const { body } = await preflight(operator, 'oa.admin');
    expect(body).toMatchObject({
      status: 'refused',
      reason: 'privileged',
      message: expect.stringMatching(/member of (Domain Admins|Administrators)/),
    });

    await operator.stepUp();
    const res = await issue(operator, 'oa.admin');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'privileged' } });
    const refused = await api.app.db
      .selectFrom('audit_events')
      .select(['result', 'error_code'])
      .where('action', '=', 'user.tap.issue')
      .where('target_id', '=', users['oa.admin']!.id)
      .executeTakeFirstOrThrow();
    expect(refused).toEqual({ result: 'failure', error_code: 'privileged' });
  });

  it('refuses a user whose nested group is mapped to the admin role', async () => {
    // Alice is in Engineering, which is in All Staff.
    const key = 'authz.admin_group_dn';
    const before = await api.app.services.settings.get<string | null>(key, null);
    const setAdminGroup = async (dn: string | null) => {
      await api.app.db
        .updateTable('app_settings')
        .set({ value_json: JSON.stringify(dn) })
        .where('key', '=', key)
        .execute();
      api.app.services.settings.invalidate(key);
    };
    await setAdminGroup(`CN=All Staff,${GROUPS}`);
    try {
      const { body } = await preflight(operator, 'alice.anders');
      expect(body).toMatchObject({
        status: 'refused',
        reason: 'privileged',
        message: expect.stringContaining('member of All Staff, which gives OpenADUC’s Admin role'),
      });
    } finally {
      await setAdminGroup(before);
    }
  });

  it('refuses a user who holds an Entra role', async () => {
    graph.roleHolders = [entraIdOf('alice.anders')];
    const { body } = await preflight(operator, 'alice.anders');
    expect(body).toMatchObject({ status: 'refused', reason: 'entraAdminRole' });
  });

  it('passes on in Entra’s words a pass Entra refuses', async () => {
    await operator.stepUp();
    graph.rejectNextPass = 'The user is not targeted by the Temporary Access Pass policy.';
    const res = await issue(operator, 'alice.anders');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: {
        code: 'entra_rejected',
        message:
          'Microsoft Entra refused: The user is not targeted by the Temporary Access Pass policy.',
      },
    });
  });

  it('finds Domain Admins and Builtin groups with a base DN that’s an OU', async () => {
    const provider = new ActiveDirectoryProvider({
      id: api.directoryId!,
      name: 'ou-base',
      baseDn: 'OU=OpenADUC Test,DC=openaduc,DC=test',
      ldapUrls: [DC.ldapsUrl],
      tlsMode: 'ldaps',
      tlsRejectUnauthorized: true,
      tlsCaPath: DC.caPath,
      operationTimeoutMs: 10_000,
      serviceAccountUpn: `${DC.serviceAccount}@${DC.domain}`,
      serviceAccountPassword: DC.password,
    });
    const token = await provider.getUserTokenGroups({
      kind: 'objectGuid',
      value: users['oa.admin']!.id,
    });
    expect(token!.groups.map((g) => g.name)).toEqual(
      expect.arrayContaining(['Domain Admins', 'Administrators', 'Domain Users']),
    );
    expect(token!.sids.every((sid) => token!.groups.some((g) => g.sid === sid))).toBe(true);
  });

  it('never writes a pass’s value to the audit log, whatever a caller passes it', async () => {
    await api.app.services.audit.recordEvent({
      action: 'test.redaction',
      result: 'success',
      targetType: 'system',
      metadata: { temporaryAccessPass: PASS, nested: { temporaryAccessPass: PASS } },
    });
    const row = await api.app.db
      .selectFrom('audit_events')
      .select('metadata_json')
      .where('action', '=', 'test.redaction')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(PASS);
  });

  it('says an unsynced user is waiting for sync, with the last sync', async () => {
    const { body } = await preflight(operator, 'bob.baker');
    expect(body).toEqual({ status: 'unsynced', lastSyncAt: '2026-10-24T11:30:00.000Z' });
  });

  it('needs write:user.issueTap', async () => {
    const auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    expect((await preflight(auditor, 'alice.anders')).res.statusCode).toBe(403);
  });

  it('is unavailable until the feature is turned on', async () => {
    await api.app.services.entraIntegration.update(api.directoryId!, {
      features: { temporaryAccessPass: false },
    });
    try {
      const { res, body } = await preflight(operator, 'alice.anders');
      expect(res.statusCode).toBe(409);
      expect(body).toMatchObject({ error: { code: 'tap_not_enabled' } });
      const page = await operator.get(`/api/users/${users['alice.anders']!.id}`);
      expect(page.json()).toMatchObject({ user: { entra: { temporaryAccessPass: false } } });
    } finally {
      await api.app.services.entraIntegration.update(api.directoryId!, {
        features: { temporaryAccessPass: true },
      });
    }
  });

  it('names a permission the connection test finds missing', async () => {
    graph.roles = ['User.Read.All', 'Organization.Read.All'];
    const res = await admin.post(`/api/directories/${api.directoryId}/entra/test`);
    expect(res.json()).toMatchObject({
      ok: false,
      missingPermissions: [
        'UserAuthMethod-TAP.ReadWrite.All',
        'Policy.Read.AuthenticationMethod',
        'RoleManagement.Read.Directory',
      ],
    });

    graph.roles = [...ALL_PERMISSIONS];
    expect(
      (await admin.post(`/api/directories/${api.directoryId}/entra/test`)).json(),
    ).toMatchObject({ ok: true, missingPermissions: [] });
  });
});
