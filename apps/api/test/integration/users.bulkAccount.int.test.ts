// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client as LdapClient } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AuditBulkSummary,
  BulkAccountChange,
  BulkAccountPreview,
  BulkJob,
  BulkJobRow,
} from '@openaduc/shared';
import {
  asAdministrator,
  configureDirectory,
  DC,
  readDirectoryUser,
  reseedDirectory,
  sambaTool,
  setUserAttribute,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

type Fixture = 'alice' | 'bob' | 'carol' | 'dave' | 'erin' | 'admin';
const SAM: Record<Fixture, string> = {
  alice: 'alice.anders',
  bob: 'bob.baker',
  carol: 'carol.chen',
  dave: 'dave.diaz',
  erin: 'erin.evans',
  // In CN=Users, outside the OU oa.operator may change.
  admin: 'Administrator',
};
const ROOT = 'OU=OpenADUC Test,DC=openaduc,DC=test';
const STAFF = `OU=Staff,${ROOT}`;
const CONTRACTORS = `OU=Contractors,${ROOT}`;
const NEVER = '9223372036854775807';
const NORMAL_ACCOUNT = 0x200;
const DONT_EXPIRE_PASSWORD = 0x10000;
const toFiletime = (iso: string) =>
  ((BigInt(Date.parse(iso)) + 11644473600000n) * 10000n).toString();

interface AuditRow {
  action: string;
  result: string;
  targetId: string | null;
  errorCode: string | null;
  bulkJobId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  bulk: AuditBulkSummary | null;
}

const dnOf = async (sam: string) =>
  String((await readDirectoryUser(sam, ['distinguishedName']))!.dn);
const leaf = (dn: string) => dn.slice(0, dn.indexOf(','));

/** Put a fixture back in an OU, as Administrator, wherever a test left it. */
async function putIn(sam: string, ou: string): Promise<void> {
  const dn = await dnOf(sam);
  if (dn.toLowerCase().endsWith(`,${ou.toLowerCase()}`)) return;
  await asAdministrator((client) => client.modifyDN(dn, `${leaf(dn)},${ou}`));
}

/** Whether the user can sign in with the fixture password; AD's reason when not (773: must change it). */
async function signInAs(sam: string): Promise<string> {
  const client = new LdapClient({ url: DC.ldapsUrl, tlsOptions: { ca: readFileSync(DC.caPath) } });
  try {
    await client.bind(`${sam}@${DC.domain}`, DC.password);
    return 'ok';
  } catch (err) {
    return /data 773/.test(String(err)) ? 'must change password' : String(err);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

describe('moving users and changing their account settings in bulk', () => {
  let api: TestApi;
  let operator: TestClient;
  let auditor: TestClient;
  let users: Record<Fixture, string>;

  /** Alice, Bob and Carol as the seed has them: in their OUs, no expiry, the fixture password, which expires. */
  async function resetFixtures(): Promise<void> {
    await putIn(SAM.alice, STAFF);
    await putIn(SAM.bob, STAFF);
    await putIn(SAM.carol, CONTRACTORS);
    for (const sam of [SAM.alice, SAM.bob, SAM.carol]) {
      await setUserAttribute(sam, 'accountExpires', [NEVER]);
      // Other tests reset it; this also clears must-change.
      sambaTool('user', 'setpassword', sam, `--newpassword=${DC.password}`);
    }
    for (const sam of [SAM.alice, SAM.bob]) {
      await setUserAttribute(sam, 'userAccountControl', [String(NORMAL_ACCOUNT)]);
    }
  }

  beforeAll(async () => {
    await resetFixtures();
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    const userId = async (sam: string) =>
      (await operator.get(`/api/users?q=${sam}`))
        .json<{ rows: { id: string; samAccountName: string }[] }>()
        .rows.find((r) => r.samAccountName.toLowerCase() === sam.toLowerCase())!.id;
    users = Object.fromEntries(
      await Promise.all(
        Object.entries(SAM).map(async ([key, sam]) => [key, await userId(sam)] as const),
      ),
    ) as Record<Fixture, string>;
  });

  afterAll(async () => {
    await api?.close();
    await resetFixtures();
    reseedDirectory();
  });

  /** Read the users live, so the cache has what the DC has. */
  const refresh = (...ids: string[]) =>
    Promise.all(ids.map((id) => operator.get(`/api/users/${id}`)));

  async function preview(
    ids: string[],
    change: BulkAccountChange,
    client = operator,
    page: { offset?: number; limit?: number } = {},
  ): Promise<BulkAccountPreview> {
    const res = await client.post('/api/users/bulk-account/preview', { ids, change, ...page });
    expect(res.statusCode).toBe(200);
    return res.json<BulkAccountPreview>();
  }

  // By fixture, not display name: other tests rename fixture accounts.
  const nameOf = (id: string) => Object.entries(users).find(([, u]) => u === id)?.[0] ?? id;
  const names = (list: { users: { id: string }[] }) => list.users.map((u) => nameOf(u.id));

  describe('the preview', () => {
    it('says who a move changes, from where, and who is in the OU already', async () => {
      const ids = [users.alice, users.bob, users.carol, randomUUID()];
      const result = await preview(ids, { op: 'move', targetOuDn: CONTRACTORS });

      expect(result).toMatchObject({
        op: 'move',
        ou: { distinguishedName: CONTRACTORS, name: 'Contractors' },
        unknownCount: 1,
        notes: [],
      });
      expect(result.changed.count).toBe(2);
      expect(result.changed.users.map((u) => [nameOf(u.id), u.from])).toEqual(
        expect.arrayContaining([
          ['alice', STAFF],
          ['bob', STAFF],
        ]),
      );
      expect(names(result.unchanged)).toEqual(['carol']);

      const second = await preview(ids, { op: 'move', targetOuDn: CONTRACTORS }, operator, {
        offset: 1,
        limit: 1,
      });
      expect(second.changed).toMatchObject({ count: 2, offset: 1 });
      expect(second.changed.users).toEqual([result.changed.users[1]]);
      expect(second.previewToken).toBe(result.previewToken);

      const unknown = await operator.post('/api/users/bulk-account/preview', {
        ids,
        change: { op: 'move', targetOuDn: `OU=Nowhere,${ROOT}` },
      });
      expect(unknown.statusCode).toBe(404);
    });

    it('says who already expires then, or never', async () => {
      const expiresAt = '2031-03-01T00:00:00.000Z';
      await setUserAttribute(SAM.alice, 'accountExpires', [toFiletime(expiresAt)]);
      await refresh(users.alice, users.bob);
      try {
        const set = await preview([users.alice, users.bob], { op: 'accountExpiry', expiresAt });
        expect(names(set.unchanged)).toEqual(['alice']);
        expect(set.changed.users).toEqual([
          { id: users.bob, name: expect.any(String), from: null },
        ]);

        const never = await preview([users.alice, users.bob], {
          op: 'accountExpiry',
          expiresAt: null,
        });
        expect(names(never.unchanged)).toEqual(['bob']);
        expect(never.changed.users).toEqual([
          { id: users.alice, name: expect.any(String), from: expiresAt },
        ]);
      } finally {
        await setUserAttribute(SAM.alice, 'accountExpires', [NEVER]);
        await refresh(users.alice);
      }
    });

    it('points out who must-change won’t reach: never-expires and random-password users', async () => {
      await setUserAttribute(SAM.bob, 'userAccountControl', [
        String(NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD),
      ]);
      await refresh(users.bob);
      // Alice and Dave were last given a password by a random-mode create
      // (Dave's failed part-way, after the password); Carol's was reset
      // since, and Bob has set his own since.
      const providerId = api.directoryId!;
      const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
      const event = (action: string, targetId: string, at: string, result = 'success') => ({
        action,
        result,
        provider_id: providerId,
        target_type: 'user',
        target_id: targetId,
        timestamp: at,
        metadata_json: JSON.stringify(
          action === 'user.password.reset' ? {} : { passwordMode: 'random', mustChange: false },
        ),
      });
      await api.app.db
        .insertInto('audit_events')
        .values([
          event('user.create', users.alice, minutesAgo(0)),
          event('user.create', users.dave, minutesAgo(1), 'failure'),
          event('user.create', users.carol, minutesAgo(2)),
          event('user.password.reset', users.carol, minutesAgo(1)),
          event('user.create', users.bob, '2026-01-01T00:00:00Z'),
        ])
        .execute();
      try {
        const result = await preview(
          [users.alice, users.bob, users.carol, users.dave, users.erin],
          { op: 'mustChangePassword' },
        );
        expect(names(result.unchanged)).toEqual(['erin']);
        expect(result.changed.count).toBe(4);
        expect(result.notes).toEqual(
          expect.arrayContaining([
            {
              kind: 'never_expires',
              count: 1,
              users: [expect.objectContaining({ id: users.bob })],
            },
            {
              kind: 'random_password',
              count: 2,
              users: expect.arrayContaining([
                { id: users.alice, name: expect.any(String) },
                { id: users.dave, name: expect.any(String) },
              ]),
            },
          ]),
        );
        expect(result.notes).toHaveLength(2);
      } finally {
        await setUserAttribute(SAM.bob, 'userAccountControl', [String(NORMAL_ACCOUNT)]);
        await refresh(users.bob);
      }
    });

    it('says who clearing never-expires changes, and who it asks to change their password', async () => {
      for (const sam of [SAM.bob, SAM.erin]) {
        await setUserAttribute(sam, 'userAccountControl', [
          String(NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD),
        ]);
      }
      await refresh(users.bob, users.erin);
      try {
        const result = await preview([users.alice, users.bob, users.erin], {
          op: 'clearPasswordNeverExpires',
        });
        expect(names(result.unchanged)).toEqual(['alice']);
        expect(result.changed.users.map((u) => nameOf(u.id)).sort()).toEqual(['bob', 'erin']);
        expect(result.notes).toEqual([
          { kind: 'must_change', count: 1, users: [expect.objectContaining({ id: users.erin })] },
        ]);
      } finally {
        for (const sam of [SAM.bob, SAM.erin]) {
          await setUserAttribute(sam, 'userAccountControl', [String(NORMAL_ACCOUNT)]);
        }
        await refresh(users.bob, users.erin);
      }
    });

    it('is a read anyone with read:user may make, and writes nothing', async () => {
      const read = await preview([users.alice], { op: 'mustChangePassword' }, auditor);
      expect(read.changed.count).toBe(1);
      const written = await api.app.db
        .selectFrom('audit_events')
        .select('action')
        .where('action', 'in', ['user.move', 'user.passwordMustChange.set'])
        .execute();
      expect(written).toEqual([]);
    });
  });

  describe('the jobs', () => {
    async function start(ids: string[], change: BulkAccountChange, path: string) {
      const { previewToken } = await preview(ids, change);
      const res = await operator.post(path, { ids, change, previewToken });
      expect(res.statusCode).toBe(202);
      return res.json<{ job: BulkJob }>().job;
    }

    async function finished(id: string): Promise<BulkJob> {
      for (let i = 0; i < 300; i++) {
        const { job } = (await operator.get(`/api/bulk-jobs/${id}`)).json<{ job: BulkJob }>();
        if (job.status !== 'queued' && job.status !== 'running' && job.counts.pending === 0) {
          return job;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`bulk job ${id} didn’t finish`);
    }

    const rowsWith = async (id: string, status: BulkJobRow['status']) =>
      (await operator.get(`/api/bulk-jobs/${id}/rows?status=${status}`)).json<{
        rows: BulkJobRow[];
      }>().rows;

    const jobEvents = async (id: string) =>
      (await auditor.get(`/api/audit-events?bulkJobId=${id}&pageSize=200`))
        .json<{ rows: AuditRow[] }>()
        .rows.reverse();

    const failedWith = async (id: string) =>
      (await rowsWith(id, 'failed')).map((r) => [nameOf(r.targetId), r.errorCode]);

    const missing = randomUUID();

    it('moves the users, skips the one there already, and fails those it may not move', async () => {
      try {
        const queued = await start(
          [users.alice, users.bob, users.carol, users.admin, missing],
          { op: 'move', targetOuDn: CONTRACTORS },
          '/api/users/bulk-move',
        );
        expect(queued).toMatchObject({
          action: 'user.move',
          subject: { ou: { distinguishedName: CONTRACTORS, name: 'Contractors' } },
        });

        const job = await finished(queued.id);

        expect(job).toMatchObject({
          status: 'finished',
          counts: { total: 5, succeeded: 2, skipped: 1, failed: 2 },
        });
        for (const sam of [SAM.alice, SAM.bob, SAM.carol]) {
          expect((await dnOf(sam)).endsWith(`,${CONTRACTORS}`)).toBe(true);
        }
        expect(await dnOf(SAM.admin)).toBe('CN=Administrator,CN=Users,DC=openaduc,DC=test');
        expect(await failedWith(job.id)).toEqual(
          expect.arrayContaining([
            ['admin', 'permission_denied'],
            [missing, 'not_found'],
          ]),
        );

        // Audited as the single-user move, grouped under the job.
        const [heading, ...rows] = await jobEvents(job.id);
        expect(heading).toMatchObject({ action: 'bulk.create', result: 'success' });
        expect(rows.map((e) => [e.action, e.result, nameOf(e.targetId!)])).toEqual(
          expect.arrayContaining([
            ['user.move', 'success', 'alice'],
            ['user.move', 'success', 'bob'],
            ['user.move', 'success', 'carol'],
            ['user.move', 'failure', 'admin'],
            ['user.move', 'failure', missing],
          ]),
        );
        expect(rows).toHaveLength(5);
        const alice = rows.find((e) => e.targetId === users.alice)!;
        expect(alice).toMatchObject({
          metadata: { targetOuDn: CONTRACTORS, targetOuName: 'Contractors' },
          before: { parentDn: STAFF },
          after: { parentDn: CONTRACTORS },
        });
        const carol = rows.find((e) => e.targetId === users.carol)!;
        expect(carol).toMatchObject({
          metadata: { unchanged: true, targetOuName: 'Contractors' },
          before: { parentDn: CONTRACTORS },
        });
        expect(carol.after).toEqual(carol.before);

        const grouped = (await auditor.get('/api/audit-events?groupBulk=1&pageSize=200')).json<{
          rows: AuditRow[];
        }>().rows;
        expect(grouped.filter((e) => e.bulkJobId === job.id)).toEqual([
          expect.objectContaining({
            action: 'bulk.create',
            bulk: expect.objectContaining({
              action: 'user.move',
              subject: { ou: { distinguishedName: CONTRACTORS, name: 'Contractors' } },
              status: 'finished',
              total: 5,
              counts: expect.objectContaining({ succeeded: 2, skipped: 1, failed: 2 }),
            }),
          }),
        ]);

        // The cache has them where they went.
        const after = await preview([users.alice, users.bob], {
          op: 'move',
          targetOuDn: CONTRACTORS,
        });
        expect(after.changed.count).toBe(0);
      } finally {
        await putIn(SAM.alice, STAFF);
        await putIn(SAM.bob, STAFF);
        await refresh(users.alice, users.bob);
      }
    });

    it('sets when the accounts expire, then clears it', async () => {
      const expiresAt = '2031-03-01T00:00:00.000Z';
      const set = await finished(
        (
          await start(
            [users.alice, users.bob, users.admin],
            { op: 'accountExpiry', expiresAt },
            '/api/users/bulk-account-expiry',
          )
        ).id,
      );

      expect(set).toMatchObject({
        subject: { expiresAt },
        counts: { total: 3, succeeded: 2, failed: 1 },
      });
      for (const sam of [SAM.alice, SAM.bob]) {
        expect((await readDirectoryUser(sam, ['accountExpires']))?.accountExpires).toBe(
          toFiletime(expiresAt),
        );
      }
      expect(await failedWith(set.id)).toEqual([['admin', 'permission_denied']]);
      const event = (await jobEvents(set.id)).find((e) => e.targetId === users.alice)!;
      expect(event).toMatchObject({
        action: 'user.accountExpiry.set',
        metadata: { expiresAt },
        before: { accountExpiresAt: null },
        after: { accountExpiresAt: expiresAt },
      });

      const cleared = await finished(
        (
          await start(
            [users.alice, users.bob, users.carol],
            { op: 'accountExpiry', expiresAt: null },
            '/api/users/bulk-account-expiry',
          )
        ).id,
      );
      expect(cleared).toMatchObject({
        subject: { expiresAt: null },
        counts: { total: 3, succeeded: 2, skipped: 1 },
      });
      for (const sam of [SAM.alice, SAM.bob]) {
        expect((await readDirectoryUser(sam, ['accountExpires']))?.accountExpires).toBe(NEVER);
      }
    });

    it('makes them change their password, which AD holds back while it never expires', async () => {
      await setUserAttribute(SAM.bob, 'userAccountControl', [
        String(NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD),
      ]);
      await refresh(users.bob);

      const job = await finished(
        (
          await start(
            [users.alice, users.bob, users.erin, users.admin],
            { op: 'mustChangePassword' },
            '/api/users/bulk-require-password-change',
          )
        ).id,
      );

      expect(job).toMatchObject({
        subject: null,
        counts: { total: 4, succeeded: 2, skipped: 1, failed: 1 },
      });
      for (const sam of [SAM.alice, SAM.bob]) {
        expect((await readDirectoryUser(sam, ['pwdLastSet']))?.pwdLastSet).toBe('0');
      }
      expect(await failedWith(job.id)).toEqual([['admin', 'permission_denied']]);
      expect(await signInAs(SAM.alice)).toBe('must change password');
      // Its password never expires, so AD doesn't ask Bob to change it yet.
      expect(await signInAs(SAM.bob)).toBe('ok');
      const events = await jobEvents(job.id);
      expect(events.find((e) => e.targetId === users.alice)).toMatchObject({
        action: 'user.passwordMustChange.set',
        result: 'success',
        before: { passwordMustChange: false },
        after: { passwordMustChange: true },
      });
      expect(events.find((e) => e.targetId === users.erin)).toMatchObject({
        result: 'success',
        metadata: { unchanged: true },
        before: { passwordMustChange: true },
      });
    });

    it('clears “password never expires”, after which AD asks for the change', async () => {
      // Outside oa.operator's rights, with never-expires to clear.
      const adminUac = String(
        (await readDirectoryUser(SAM.admin, ['userAccountControl']))!.userAccountControl,
      );
      await setUserAttribute(SAM.admin, 'userAccountControl', [
        String(Number(adminUac) | DONT_EXPIRE_PASSWORD),
      ]);
      await refresh(users.admin);
      try {
        await clearNeverExpires();
      } finally {
        await setUserAttribute(SAM.admin, 'userAccountControl', [adminUac]);
      }
    });

    async function clearNeverExpires(): Promise<void> {
      const job = await finished(
        (
          await start(
            [users.alice, users.bob, users.admin],
            { op: 'clearPasswordNeverExpires' },
            '/api/users/bulk-clear-password-never-expires',
          )
        ).id,
      );

      expect(job.counts).toMatchObject({ total: 3, succeeded: 1, skipped: 1, failed: 1 });
      const uac = Number(
        (await readDirectoryUser(SAM.bob, ['userAccountControl']))!.userAccountControl,
      );
      expect(uac & DONT_EXPIRE_PASSWORD).toBe(0);
      expect(uac & NORMAL_ACCOUNT).toBe(NORMAL_ACCOUNT);
      expect(await signInAs(SAM.bob)).toBe('must change password');
      expect(await failedWith(job.id)).toEqual([['admin', 'permission_denied']]);
      expect((await jobEvents(job.id)).find((e) => e.targetId === users.bob)).toMatchObject({
        action: 'user.passwordNeverExpires.clear',
        before: { passwordNeverExpires: true },
        after: { passwordNeverExpires: false },
      });
    }

    it('runs only on the users and change previewed, at the route for its change', async () => {
      const ids = [users.bob];
      const change: BulkAccountChange = { op: 'move', targetOuDn: CONTRACTORS };
      const { previewToken } = await preview(ids, change);

      for (const body of [
        { ids: [users.bob, users.alice], change, previewToken },
        { ids, change: { op: 'move', targetOuDn: STAFF }, previewToken },
      ]) {
        const res = await operator.post('/api/users/bulk-move', body);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: { message: expect.stringMatching(/Preview/) } });
      }
      const elsewhere = await operator.post('/api/users/bulk-account-expiry', {
        ids,
        change,
        previewToken,
      });
      expect(elsewhere.statusCode).toBe(400);
      expect((await dnOf(SAM.bob)).endsWith(`,${STAFF}`)).toBe(true);
    });

    it('takes each change’s capability and a step-up', async () => {
      const ids = [users.bob];
      const change: BulkAccountChange = { op: 'mustChangePassword' };
      const { previewToken } = await preview(ids, change);
      const path = '/api/users/bulk-require-password-change';

      await auditor.stepUp();
      const denied = await auditor.post(path, { ids, change, previewToken });
      expect(denied.statusCode).toBe(403);
      const deny = await api.app.db
        .selectFrom('audit_events')
        .select('metadata_json')
        .where('action', '=', 'authz.deny')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();
      expect(deny.metadata_json).toMatchObject({
        requiredCapability: 'write:user.resetPassword',
      });

      const unelevated = api.client();
      await unelevated.signIn(api, 'oa.operator');
      const res = await unelevated.post(path, { ids, change, previewToken });
      expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });
    });
  });

  it('audits a single-user move to the OU the user is in as a no-op, without writing', async () => {
    const res = await operator.post(`/api/users/${users.alice}/move`, { targetOuDn: STAFF });
    expect(res.statusCode).toBe(200);
    const event = await api.app.db
      .selectFrom('audit_events')
      .select(['result', 'metadata_json', 'before_json', 'after_json'])
      .where('action', '=', 'user.move')
      .where('target_id', '=', users.alice)
      .where('bulk_job_id', 'is', null)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      result: 'success',
      metadata_json: { unchanged: true, targetOuDn: STAFF },
      before_json: { parentDn: STAFF },
    });
    expect(event.after_json).toEqual(event.before_json);
  });
});
