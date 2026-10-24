// SPDX-License-Identifier: BUSL-1.1
// Reverting each kind of bulk job against the dev DC, and what counts as
// changed since: a value changed and changed back, an OU or manager
// renamed (which isn't), and a revert racing a retry.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BulkJob, BulkJobRevertPreview, BulkJobRow } from '@openaduc/shared';
import {
  asAdministrator,
  configureDirectory,
  DC,
  expectOk,
  previewedJob,
  readDirectoryUser,
  reseedDirectory,
  revertJob,
  sambaTool,
  setGroupMember,
  setUserAttribute,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const ROOT = 'OU=OpenADUC Test,DC=openaduc,DC=test';
const STAFF = `OU=Staff,${ROOT}`;
const CONTRACTORS = `OU=Contractors,${ROOT}`;
const GROUPS = `OU=Groups,${ROOT}`;
const NEVER = '9223372036854775807';
const NORMAL_ACCOUNT = 0x200;
const DONT_EXPIRE_PASSWORD = 0x10000;
const ACCOUNTDISABLE = 0x2;

type Fixture = 'alice' | 'bob' | 'dave' | 'erin';
const SAM: Record<Fixture, string> = {
  alice: 'alice.anders',
  bob: 'bob.baker',
  dave: 'dave.diaz',
  erin: 'erin.evans',
};

const read = async (sam: string, name: string) =>
  (await readDirectoryUser(sam, [name]))?.[name] ?? null;
const dnOf = async (sam: string) => String(await read(sam, 'distinguishedName'));
const uac = async (sam: string) => Number(await read(sam, 'userAccountControl'));
const leaf = (dn: string) => dn.slice(0, dn.indexOf(','));

const members = (groupDn: string) =>
  asAdministrator(async (client) => {
    const { searchEntries } = await client.search(groupDn, {
      scope: 'base',
      filter: '(objectClass=group)',
      attributes: ['member'],
    });
    const member = searchEntries[0]?.member ?? [];
    return (Array.isArray(member) ? member : [member]).map((dn) => String(dn).toLowerCase());
  });

/** Rename an object in place, as Administrator. */
const rename = (dn: string, rdn: string) =>
  asAdministrator((client) => client.modifyDN(dn, `${rdn},${dn.slice(dn.indexOf(',') + 1)}`));

async function putIn(sam: string, ou: string): Promise<void> {
  const dn = await dnOf(sam);
  if (dn.toLowerCase().endsWith(`,${ou.toLowerCase()}`)) return;
  await asAdministrator((client) => client.modifyDN(dn, `${leaf(dn)},${ou}`));
}

describe('reverting each kind of bulk job', () => {
  let api: TestApi;
  let admin: TestClient;
  let operator: TestClient;
  let users: Record<Fixture, string>;
  const groups: Record<string, string> = {};

  async function resetFixtures(): Promise<void> {
    await putIn(SAM.alice, STAFF);
    await putIn(SAM.bob, STAFF);
    for (const sam of [SAM.alice, SAM.bob]) {
      await setUserAttribute(sam, 'userAccountControl', [String(NORMAL_ACCOUNT)]);
      await setUserAttribute(sam, 'accountExpires', [NEVER]);
      await setUserAttribute(sam, 'manager', []);
      sambaTool('user', 'setpassword', sam, `--newpassword=${DC.password}`);
    }
    await setGroupMember(`CN=Engineering,${GROUPS}`, SAM.alice, true);
    await setGroupMember(`CN=Engineering,${GROUPS}`, SAM.bob, true);
    await setGroupMember(`CN=All Staff,${GROUPS}`, SAM.alice, false);
    await setGroupMember('CN=Backup Operators,CN=Builtin,DC=openaduc,DC=test', SAM.alice, false);
  }

  beforeAll(async () => {
    reseedDirectory();
    await resetFixtures();
    api = await startApi();
    admin = await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    const userId = async (sam: string) =>
      (await operator.get(`/api/users?q=${sam}`))
        .json<{ rows: { id: string; samAccountName: string }[] }>()
        .rows.find((r) => r.samAccountName.toLowerCase() === sam.toLowerCase())!.id;
    users = Object.fromEntries(
      await Promise.all(
        Object.entries(SAM).map(async ([key, sam]) => [key, await userId(sam)] as const),
      ),
    ) as Record<Fixture, string>;
    for (const name of ['Engineering', 'All Staff', 'Domain Users', 'Backup Operators']) {
      groups[name] = (await operator.get(`/api/groups?q=${encodeURIComponent(name)}`))
        .json<{ rows: { id: string; name: string }[] }>()
        .rows.find((g) => g.name === name)!.id;
    }
  });

  beforeEach(async () => {
    await resetFixtures();
    await refresh(users.alice, users.bob);
  });

  afterAll(async () => {
    await api?.close();
    await resetFixtures();
    reseedDirectory();
  });

  const refresh = (...ids: string[]) =>
    Promise.all(ids.map((id) => operator.get(`/api/users/${id}`)));

  async function previewRevert(jobId: string, client = admin): Promise<BulkJobRevertPreview> {
    const res = await client.get(`/api/bulk-jobs/${jobId}/revert/preview`);
    expect(res.statusCode).toBe(200);
    return res.json<BulkJobRevertPreview>();
  }

  async function start(path: string, ids: string[], client = operator): Promise<BulkJob> {
    const res = await client.post(path, { ids });
    expect(res.statusCode).toBe(202);
    for (let i = 0; i < 300; i++) {
      const { job } = (
        await client.get(`/api/bulk-jobs/${res.json<{ job: BulkJob }>().job.id}`)
      ).json<{
        job: BulkJob;
      }>();
      if (job.status === 'finished') return job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('job didn’t finish');
  }

  const accountChange = (ids: string[], change: Record<string, unknown>, path: string) =>
    previewedJob(operator, '/api/users/bulk-account/preview', path, { ids, change });

  const membership = (
    op: 'add' | 'remove',
    ids: string[],
    groupIds: string[],
    client = operator,
    more: Record<string, unknown> = {},
  ) =>
    previewedJob(
      client,
      '/api/users/bulk-groups/preview',
      op === 'add' ? '/api/users/bulk-add-to-groups' : '/api/users/bulk-remove-from-groups',
      { ids, groupIds, ...more },
      { op, ids, groupIds },
    );

  const rowsOf = async (jobId: string, client = admin) =>
    (await client.get(`/api/bulk-jobs/${jobId}/rows`)).json<{ rows: BulkJobRow[] }>().rows;

  it('enables the accounts a bulk disable disabled, as a job of the opposite action', async () => {
    const job = await start('/api/users/bulk-disable', [users.alice, users.bob]);
    expect(await uac(SAM.alice)).toBe(NORMAL_ACCOUNT | ACCOUNTDISABLE);

    const reverted = await revertJob(admin, job.id);

    expect(reverted).toMatchObject({ action: 'user.enable', revertsJobId: job.id });
    expect(reverted.counts.succeeded).toBe(2);
    expect(await uac(SAM.alice)).toBe(NORMAL_ACCOUNT);
    expect(await uac(SAM.bob)).toBe(NORMAL_ACCOUNT);
  });

  it('flags an account enabled and disabled again since, though it’s as the job left it', async () => {
    const job = await start('/api/users/bulk-disable', [users.alice, users.bob]);
    expectOk(await operator.post(`/api/users/${users.alice}/enable`), 'enable');
    expectOk(await operator.post(`/api/users/${users.alice}/disable`), 'disable');

    const preview = await previewRevert(job.id);

    expect(preview.revert.users.map((u) => u.id)).toEqual([users.bob]);
    expect(preview.modified.users).toEqual([
      expect.objectContaining({ id: users.alice, changedSince: expect.any(String) }),
    ]);
    await revertJob(admin, job.id);
    expect(await uac(SAM.alice)).toBe(NORMAL_ACCOUNT | ACCOUNTDISABLE);
    expect(await uac(SAM.bob)).toBe(NORMAL_ACCOUNT);
  });

  it('flags a membership removed and added again since', async () => {
    const job = await membership('add', [users.alice], [groups['All Staff']!]);
    const groupId = groups['All Staff'];
    expectOk(await operator.delete(`/api/users/${users.alice}/groups`, { groupId }), 'remove');
    expectOk(await operator.post(`/api/users/${users.alice}/groups`, { groupId }), 'add');

    const preview = await previewRevert(job.id);

    expect(preview.revert.count).toBe(0);
    expect(preview.modified.users[0]).toMatchObject({
      id: users.alice,
      changedSince: expect.stringMatching(/user\.group\.(add|remove)/),
    });
    const included = await revertJob(admin, job.id, { include: 'all' });
    expect(included.counts.succeeded).toBe(1);
    expect(await members(`CN=All Staff,${GROUPS}`)).not.toContain(
      (await dnOf(SAM.alice)).toLowerCase(),
    );
  });

  it('puts back users a bulk remove took out of a group', async () => {
    const job = await membership('remove', [users.alice, users.bob], [groups.Engineering!]);
    expect(await members(`CN=Engineering,${GROUPS}`)).not.toContain(
      (await dnOf(SAM.alice)).toLowerCase(),
    );

    const reverted = await revertJob(operator, job.id);

    expect(reverted).toMatchObject({ action: 'user.group.add', counts: { succeeded: 2 } });
    const now = await members(`CN=Engineering,${GROUPS}`);
    expect(now).toContain((await dnOf(SAM.alice)).toLowerCase());
    expect(now).toContain((await dnOf(SAM.bob)).toLowerCase());
  });

  it('leaves out a primary group the job recorded as already done', async () => {
    const job = await membership(
      'add',
      [users.alice],
      [groups['All Staff']!, groups['Domain Users']!],
    );

    const preview = await previewRevert(job.id);

    expect(preview.revert.users[0]!.changes).toEqual([
      { field: 'group', group: 'All Staff', job: true, now: true, restore: false },
    ]);
    await revertJob(admin, job.id);
    expect(await read(SAM.alice, 'primaryGroupID')).toBe('513');
  });

  it('asks before putting users back in a group AD protects', async () => {
    const add = await membership('add', [users.alice], [groups['Backup Operators']!], admin, {
      acknowledgeProtected: true,
    });
    expect(add.counts.succeeded).toBe(1);
    const job = await membership('remove', [users.alice], [groups['Backup Operators']!], admin);

    const preview = await previewRevert(job.id);
    expect(preview.protectedGroups).toEqual([
      { id: groups['Backup Operators'], name: 'Backup Operators' },
    ]);
    const refused = await admin.post(`/api/bulk-jobs/${job.id}/revert`, {
      previewToken: preview.previewToken,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      error: { message: expect.stringMatching(/admin rights/) },
    });

    const reverted = await revertJob(admin, job.id, { acknowledgeProtected: true });
    expect(reverted.counts.succeeded).toBe(1);
  });

  it('moves users back to the OU they came from, by GUID however it’s been renamed', async () => {
    const job = await accountChange(
      [users.alice, users.bob],
      { op: 'move', targetOuDn: CONTRACTORS },
      '/api/users/bulk-move',
    );
    expect(job.counts.succeeded).toBe(2);
    // Both OUs renamed since: the destination isn't "changed since", nor the origin missing.
    await rename(CONTRACTORS, 'OU=Vendors');
    await rename(STAFF, 'OU=People');
    try {
      await refresh(users.alice, users.bob);

      const preview = await previewRevert(job.id);
      expect(preview.revert.count).toBe(2);
      expect(preview.modified.count).toBe(0);
      expect(preview.revert.users[0]!.changes[0]).toMatchObject({
        field: 'ou',
        job: `OU=Vendors,${ROOT}`,
        restore: `OU=People,${ROOT}`,
      });

      const reverted = await revertJob(admin, job.id);
      expect(reverted).toMatchObject({ action: 'user.move', counts: { succeeded: 2 } });
      expect((await dnOf(SAM.alice)).toLowerCase()).toMatch(/,ou=people,ou=openaduc test,/);
    } finally {
      await rename(`OU=People,${ROOT}`, 'OU=Staff');
      await rename(`OU=Vendors,${ROOT}`, 'OU=Contractors');
    }
  });

  it('puts back a manager by GUID however they’ve been renamed', async () => {
    await setUserAttribute(SAM.alice, 'manager', [await dnOf(SAM.dave)]);
    await refresh(users.alice);
    const job = await previewedJob(
      operator,
      '/api/users/bulk-update/preview',
      '/api/users/bulk-update',
      {
        ids: [users.alice],
        changes: { manager: users.erin },
      },
    );
    const daveDn = await dnOf(SAM.dave);
    const erinDn = await dnOf(SAM.erin);
    await rename(daveDn, 'CN=Dave D');
    await rename(erinDn, 'CN=Erin E');
    try {
      await refresh(users.alice);

      const preview = await previewRevert(job.id);
      expect(preview.modified.count).toBe(0);
      expect(preview.revert.users[0]!.changes).toEqual([
        {
          field: 'manager',
          job: expect.stringMatching(/Erin/),
          now: expect.stringMatching(/Erin/),
          restore: expect.stringMatching(/Dave/),
        },
      ]);

      await revertJob(admin, job.id);
      expect(String(await read(SAM.alice, 'manager')).toLowerCase()).toBe(
        (await dnOf(SAM.dave)).toLowerCase(),
      );
    } finally {
      await rename(await dnOf(SAM.dave), leaf(daveDn));
      await rename(await dnOf(SAM.erin), leaf(erinDn));
    }
  });

  it('puts back when accounts expired, and says when the job couldn’t read its own back', async () => {
    const job = await accountChange(
      [users.alice, users.bob],
      { op: 'accountExpiry', expiresAt: '2031-03-01T00:00:00.000Z' },
      '/api/users/bulk-account-expiry',
    );
    // As if the job's re-read of Bob had failed.
    await api.app.db
      .updateTable('bulk_job_rows')
      .set({ after_json: JSON.stringify({}) })
      .where('job_id', '=', job.id)
      .where('target_id', '=', users.bob)
      .execute();

    const preview = await previewRevert(job.id);
    expect(preview.modified.count).toBe(0);
    expect(preview.revert.users.find((u) => u.id === users.bob)!.changes[0]).toMatchObject({
      field: 'accountExpires',
      job: null,
      unverified: true,
      restore: null,
    });

    const reverted = await revertJob(admin, job.id);
    expect(reverted.counts.succeeded).toBe(2);
    expect(String(await read(SAM.alice, 'accountExpires'))).toMatch(/^(0|9223372036854775807)$/);
  });

  it('sets “password never expires” again where a bulk clear cleared it', async () => {
    await setUserAttribute(SAM.alice, 'userAccountControl', [
      String(NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD),
    ]);
    await refresh(users.alice);
    const job = await accountChange(
      [users.alice],
      { op: 'clearPasswordNeverExpires' },
      '/api/users/bulk-clear-password-never-expires',
    );
    expect(await uac(SAM.alice)).toBe(NORMAL_ACCOUNT);

    const reverted = await revertJob(admin, job.id);

    expect(reverted).toMatchObject({
      action: 'user.passwordNeverExpires.set',
      counts: { succeeded: 1 },
    });
    expect(await uac(SAM.alice)).toBe(NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD);
  });

  it('won’t revert a job with rows still finishing, or while a stopped revert’s rows run', async () => {
    const job = await start('/api/users/bulk-disable', [users.alice]);
    const [row] = await api.app.db
      .selectFrom('bulk_job_rows')
      .select('id')
      .where('job_id', '=', job.id)
      .execute();
    await api.app.db
      .updateTable('bulk_job_rows')
      .set({ status: 'running' })
      .where('id', '=', row!.id)
      .execute();
    expect((await admin.get(`/api/bulk-jobs/${job.id}/revert/preview`)).statusCode).toBe(409);
    await api.app.db
      .updateTable('bulk_job_rows')
      .set({ status: 'succeeded' })
      .where('id', '=', row!.id)
      .execute();

    const { previewToken } = await previewRevert(job.id);
    const stopped = await api.app.db
      .insertInto('bulk_jobs')
      .values({
        provider_id: api.directoryId!,
        action: 'user.enable',
        status: 'cancelled',
        actor_user_id: 'someone',
        actor_username: 'someone',
        admin_session_id: '00000000-0000-0000-0000-000000000000',
        reverts_job_id: job.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.app.db
      .insertInto('bulk_job_rows')
      .values({ job_id: stopped.id, ordinal: 0, target_id: users.alice, status: 'running' })
      .execute();

    const res = await admin.post(`/api/bulk-jobs/${job.id}/revert`, { previewToken });
    expect(res.statusCode).toBe(409);
    await api.app.db
      .updateTable('bulk_job_rows')
      .set({ status: 'skipped' })
      .where('job_id', '=', stopped.id)
      .execute();
    await revertJob(admin, job.id);
  });

  it('won’t retry a revert while another revert of the same job is under way', async () => {
    const job = await start('/api/users/bulk-disable', [users.alice, users.bob]);
    const first = await revertJob(admin, job.id);
    await api.app.db
      .updateTable('bulk_job_rows')
      .set({ status: 'failed', error_code: 'directory_error' })
      .where('job_id', '=', first.id)
      .where('target_id', '=', users.bob)
      .execute();
    await api.app.db
      .insertInto('bulk_jobs')
      .values({
        provider_id: api.directoryId!,
        action: 'user.enable',
        status: 'paused',
        pause_reason: 'step_up_required',
        actor_user_id: 'someone',
        actor_username: 'someone',
        admin_session_id: '00000000-0000-0000-0000-000000000000',
        reverts_job_id: job.id,
      })
      .execute();

    const res = await admin.post(`/api/bulk-jobs/${first.id}/retry`);

    expect(res.statusCode).toBe(409);
    expect((await rowsOf(first.id)).find((r) => r.targetId === users.bob)!.status).toBe('failed');
    await api.app.db
      .updateTable('bulk_jobs')
      .set({ status: 'cancelled' })
      .where('reverts_job_id', '=', job.id)
      .where('status', '=', 'paused')
      .execute();
  });
});
