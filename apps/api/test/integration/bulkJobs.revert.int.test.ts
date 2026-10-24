// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AuditBulkSummary,
  BulkAttributeChanges,
  BulkJob,
  BulkJobRevertPreview,
  BulkJobRevertRequest,
  BulkJobRow,
} from '@openaduc/shared';
import {
  asAdministrator,
  configureDirectory,
  DC,
  finishedJob,
  readDirectoryUser,
  reseedDirectory,
  sambaTool,
  setUserAttribute,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

type Fixture = 'alice' | 'bob' | 'dave';
const SAM: Record<Fixture, string> = {
  alice: 'alice.anders',
  bob: 'bob.baker',
  dave: 'dave.diaz',
};
const SEEDED = {
  alice: { department: 'Engineering', title: 'Engineer' },
  bob: { department: 'Engineering', title: 'Senior Engineer' },
};
const ALL_STAFF = 'CN=All Staff,OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test';

interface AuditRow {
  action: string;
  result: string;
  targetId: string | null;
  bulkJobId: string | null;
  metadata: Record<string, unknown>;
  bulk: AuditBulkSummary | null;
}

const attribute = async (sam: string, name: string) =>
  (await readDirectoryUser(sam, [name]))?.[name] ?? null;

/** The group's direct members, as Administrator sees them. */
const directoryMembers = (groupDn: string) =>
  asAdministrator(async (client) => {
    const { searchEntries } = await client.search(groupDn, {
      scope: 'base',
      filter: '(objectClass=group)',
      attributes: ['member'],
    });
    const member = searchEntries[0]?.member ?? [];
    return (Array.isArray(member) ? member : [member]).map((dn) => String(dn).toLowerCase());
  });
const dnOf = async (sam: string) =>
  String((await readDirectoryUser(sam, ['distinguishedName']))!.dn).toLowerCase();

describe('reverting a bulk job', () => {
  let api: TestApi;
  let admin: TestClient;
  let operator: TestClient;
  let auditor: TestClient;
  let users: Record<Fixture, string>;
  let allStaffId: string;

  async function resetFixtures(): Promise<void> {
    for (const [key, values] of Object.entries(SEEDED)) {
      const sam = SAM[key as keyof typeof SEEDED];
      await setUserAttribute(sam, 'department', [values.department]);
      await setUserAttribute(sam, 'title', [values.title]);
      // Clears must-change too.
      sambaTool('user', 'setpassword', sam, `--newpassword=${DC.password}`);
    }
  }

  beforeAll(async () => {
    reseedDirectory();
    await resetFixtures();
    api = await startApi();
    admin = await configureDirectory(api);
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
    allStaffId = (await operator.get('/api/groups?q=All%20Staff'))
      .json<{ rows: { id: string; name: string }[] }>()
      .rows.find((g) => g.name === 'All Staff')!.id;
  });

  afterAll(async () => {
    await api?.close();
    await resetFixtures();
    reseedDirectory();
  });

  /** Read the users live, so the cache has what the DC has. */
  const refresh = (...ids: string[]) =>
    Promise.all(ids.map((id) => operator.get(`/api/users/${id}`)));

  async function editAttributes(ids: string[], changes: BulkAttributeChanges): Promise<BulkJob> {
    const preview = await operator.post('/api/users/bulk-update/preview', { ids, changes });
    const res = await operator.post('/api/users/bulk-update', {
      ids,
      changes,
      previewToken: preview.json<{ previewToken: string }>().previewToken,
    });
    expect(res.statusCode).toBe(202);
    return finishedJob(operator, res.json<{ job: BulkJob }>().job.id);
  }

  async function previewRevert(jobId: string, client = admin): Promise<BulkJobRevertPreview> {
    const res = await client.get(`/api/bulk-jobs/${jobId}/revert/preview`);
    expect(res.statusCode).toBe(200);
    return res.json<BulkJobRevertPreview>();
  }

  async function revert(
    jobId: string,
    body: Partial<BulkJobRevertRequest> = {},
    client = admin,
  ): Promise<BulkJob> {
    const { previewToken } = await previewRevert(jobId, client);
    const res = await client.post(`/api/bulk-jobs/${jobId}/revert`, { previewToken, ...body });
    expect(res.statusCode).toBe(202);
    return finishedJob(client, res.json<{ job: BulkJob }>().job.id);
  }

  const rows = async (jobId: string, client = admin) =>
    (await client.get(`/api/bulk-jobs/${jobId}/rows`)).json<{ rows: BulkJobRow[] }>().rows;

  const headingOf = async (jobId: string) =>
    (await auditor.get(`/api/audit-events?groupBulk=1&pageSize=200`))
      .json<{ rows: AuditRow[] }>()
      .rows.find((r) => r.action === 'bulk.create' && r.bulkJobId === jobId)!;

  it('puts back the attributes a bulk edit changed, as a job linked to it', async () => {
    const job = await editAttributes([users.alice, users.bob], {
      department: 'Revert QA',
      title: 'Tester',
    });
    expect(job.counts.succeeded).toBe(2);

    const preview = await previewRevert(job.id);
    expect(preview).toMatchObject({
      revert: { count: 2 },
      modified: { count: 0 },
      unchanged: { count: 0 },
      notRevertible: { count: 0 },
      excluded: 0,
    });
    const alice = preview.revert.users.find((u) => u.id === users.alice)!;
    expect(alice.changes).toEqual([
      { field: 'title', job: 'Tester', now: 'Tester', restore: 'Engineer' },
      { field: 'department', job: 'Revert QA', now: 'Revert QA', restore: 'Engineering' },
    ]);

    const reverted = await revert(job.id);

    expect(reverted).toMatchObject({
      action: 'user.update',
      revertsJobId: job.id,
      status: 'finished',
      counts: { total: 2, succeeded: 2 },
    });
    expect(await attribute(SAM.alice, 'department')).toBe('Engineering');
    expect(await attribute(SAM.alice, 'title')).toBe('Engineer');
    expect(await attribute(SAM.bob, 'title')).toBe('Senior Engineer');

    const events = (
      await auditor.get(`/api/audit-events?bulkJobId=${reverted.id}&pageSize=50`)
    ).json<{ rows: AuditRow[] }>().rows;
    expect(events.find((e) => e.action === 'bulk.create')!.metadata).toMatchObject({
      action: 'user.update',
      total: 2,
      revertsJobId: job.id,
    });
    expect(events.filter((e) => e.action === 'user.update' && e.result === 'success')).toHaveLength(
      2,
    );

    const original = await headingOf(job.id);
    expect(original.bulk).toMatchObject({
      revertible: true,
      revertsJobId: null,
      revertedBy: {
        jobId: reverted.id,
        actorDisplayName: expect.stringMatching(/Admin/),
        status: 'finished',
      },
    });
    expect((await headingOf(reverted.id)).bulk).toMatchObject({
      revertsJobId: job.id,
      revertible: false,
    });

    // Reverting it again finds nothing left to put back.
    expect((await previewRevert(job.id)).unchanged.count).toBe(2);
    const again = await admin.post(`/api/bulk-jobs/${job.id}/revert`, {
      previewToken: (await previewRevert(job.id)).previewToken,
    });
    expect(again.statusCode).toBe(422);
  });

  it('removes the users a bulk add put in a group, and leaves those it didn’t', async () => {
    const preview = await operator.post('/api/users/bulk-groups/preview', {
      op: 'add',
      ids: [users.alice, users.dave],
      groupIds: [allStaffId],
    });
    const started = await operator.post('/api/users/bulk-add-to-groups', {
      ids: [users.alice, users.dave],
      groupIds: [allStaffId],
      previewToken: preview.json<{ previewToken: string }>().previewToken,
    });
    expect(started.statusCode).toBe(202);
    const job = await finishedJob(operator, started.json<{ job: BulkJob }>().job.id);
    // Dave was in All Staff already.
    expect(job.counts).toMatchObject({ succeeded: 1, skipped: 1 });
    expect(await directoryMembers(ALL_STAFF)).toContain(await dnOf(SAM.alice));

    const plan = await previewRevert(job.id, operator);
    expect(plan.excluded).toBe(1);
    expect(plan.revert.users).toEqual([
      {
        id: users.alice,
        name: expect.any(String),
        changes: [{ field: 'group', group: 'All Staff', job: true, now: true, restore: false }],
      },
    ]);

    // The operator's own job: no view:audit needed.
    const reverted = await revert(job.id, {}, operator);

    expect(reverted.counts).toMatchObject({ total: 1, succeeded: 1 });
    const members = await directoryMembers(ALL_STAFF);
    expect(members).not.toContain(await dnOf(SAM.alice));
    expect(members).toContain(await dnOf(SAM.dave));
    const events = (
      await auditor.get(`/api/audit-events?bulkJobId=${reverted.id}&pageSize=50`)
    ).json<{ rows: AuditRow[] }>().rows;
    expect(events.map((e) => e.action)).toContain('user.group.remove');
  });

  it('flags users changed since the job and leaves them, unless they’re included', async () => {
    const job = await editAttributes([users.alice, users.bob], { department: 'Revert QA' });
    await setUserAttribute(SAM.bob, 'department', ['Changed Since']);
    await refresh(users.bob);

    const preview = await previewRevert(job.id);
    expect(preview.revert.users.map((u) => u.id)).toEqual([users.alice]);
    expect(preview.modified.users).toEqual([
      {
        id: users.bob,
        name: expect.any(String),
        changes: [
          { field: 'department', job: 'Revert QA', now: 'Changed Since', restore: 'Engineering' },
        ],
      },
    ]);

    const leftAlone = await revert(job.id);
    expect(leftAlone.counts).toMatchObject({ total: 1, succeeded: 1 });
    expect(await attribute(SAM.alice, 'department')).toBe('Engineering');
    expect(await attribute(SAM.bob, 'department')).toBe('Changed Since');
    expect((await headingOf(leftAlone.id)).bulk).toMatchObject({ total: 1 });

    const included = await revert(job.id, { include: [users.bob] });
    expect(included.counts).toMatchObject({ total: 1, succeeded: 1 });
    expect(await attribute(SAM.bob, 'department')).toBe('Engineering');
  });

  it('checks each user again as it reverts them, skipping one changed after the preview', async () => {
    const job = await editAttributes([users.alice, users.bob], { title: 'Tester' });
    const { previewToken, revert: listed } = await previewRevert(job.id);
    expect(listed.count).toBe(2);
    // Past the cache: the preview couldn't have seen it.
    await setUserAttribute(SAM.bob, 'title', ['Changed Since']);

    const res = await admin.post(`/api/bulk-jobs/${job.id}/revert`, { previewToken });
    expect(res.statusCode).toBe(202);
    const reverted = await finishedJob(admin, res.json<{ job: BulkJob }>().job.id);

    expect(reverted.counts).toMatchObject({ succeeded: 1, skipped: 1 });
    expect((await rows(reverted.id)).find((r) => r.targetId === users.bob)).toMatchObject({
      status: 'skipped',
      errorCode: 'changed_since',
    });
    expect(await attribute(SAM.bob, 'title')).toBe('Changed Since');
    expect(await attribute(SAM.alice, 'title')).toBe('Engineer');
    await setUserAttribute(SAM.bob, 'title', [SEEDED.bob.title]);
  });

  it('stops requiring a password change, which AD does by restarting the password’s age', async () => {
    const ids = [users.alice];
    const change = { op: 'mustChangePassword' as const };
    const preview = await operator.post('/api/users/bulk-account/preview', { ids, change });
    const started = await operator.post('/api/users/bulk-require-password-change', {
      ids,
      change,
      previewToken: preview.json<{ previewToken: string }>().previewToken,
    });
    const job = await finishedJob(operator, started.json<{ job: BulkJob }>().job.id);
    expect(await attribute(SAM.alice, 'pwdLastSet')).toBe('0');

    const reverted = await revert(job.id);

    expect(reverted.counts).toMatchObject({ succeeded: 1 });
    expect(Number(await attribute(SAM.alice, 'pwdLastSet'))).toBeGreaterThan(0);
    const events = (
      await auditor.get(`/api/audit-events?bulkJobId=${reverted.id}&pageSize=50`)
    ).json<{ rows: AuditRow[] }>().rows;
    expect(events.map((e) => e.action)).toContain('user.passwordMustChange.clear');
  });

  it('says an unlock can’t be reverted, nor can a revert', async () => {
    const started = await operator.post('/api/users/bulk-unlock', { ids: [users.dave] });
    const unlock = await finishedJob(operator, started.json<{ job: BulkJob }>().job.id);
    expect((await admin.get(`/api/bulk-jobs/${unlock.id}/revert/preview`)).statusCode).toBe(422);
    expect((await headingOf(unlock.id)).bulk).toMatchObject({ revertible: false });

    const job = await editAttributes([users.alice], { title: 'Tester' });
    const reverted = await revert(job.id);
    const res = await admin.get(`/api/bulk-jobs/${reverted.id}/revert/preview`);
    expect(res.statusCode).toBe(422);
  });

  it('takes the job’s capability and step-up, and view:audit for someone else’s job', async () => {
    const job = await editAttributes([users.alice], { title: 'Tester' });

    // The auditor sees the job in the audit log but can't write.
    const asAuditor = await auditor.get(`/api/bulk-jobs/${job.id}/revert/preview`);
    expect(asAuditor.statusCode).toBe(403);
    expect(asAuditor.json()).toMatchObject({ error: { code: 'forbidden' } });

    const notElevated = api.client();
    await notElevated.signIn(api, 'oa.operator');
    const { previewToken } = await previewRevert(job.id, notElevated);
    const res = await notElevated.post(`/api/bulk-jobs/${job.id}/revert`, { previewToken });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });

    // An admin's job isn't the operator's, and the operator can't see the audit log.
    const adminPreview = await admin.post('/api/users/bulk-update/preview', {
      ids: [users.bob],
      changes: { title: 'Tester' },
    });
    const adminJob = await admin.post('/api/users/bulk-update', {
      ids: [users.bob],
      changes: { title: 'Tester' },
      previewToken: adminPreview.json<{ previewToken: string }>().previewToken,
    });
    const theirs = await finishedJob(admin, adminJob.json<{ job: BulkJob }>().job.id);
    expect((await operator.get(`/api/bulk-jobs/${theirs.id}/revert/preview`)).statusCode).toBe(403);

    await revert(job.id);
    await revert(theirs.id);
  });

  it('won’t start a second revert of a job, nor retry it, while one is under way', async () => {
    // The unknown user's row fails, so the job has a row to retry.
    const job = await editAttributes([users.alice, randomUUID()], { title: 'Tester' });
    const { previewToken } = await previewRevert(job.id);
    // A revert someone else started, still paused.
    const open = await api.app.db
      .insertInto('bulk_jobs')
      .values({
        provider_id: api.directoryId!,
        action: 'user.update',
        status: 'paused',
        pause_reason: 'step_up_required',
        actor_user_id: 'someone',
        actor_username: 'someone',
        admin_session_id: '00000000-0000-0000-0000-000000000000',
        reverts_job_id: job.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect((await headingOf(job.id)).bulk).toMatchObject({
      revertible: false,
      revertedBy: { jobId: String(open.id), status: 'paused' },
    });

    const res = await admin.post(`/api/bulk-jobs/${job.id}/revert`, { previewToken });

    expect(res.statusCode).toBe(409);
    expect((await operator.post(`/api/bulk-jobs/${job.id}/retry`)).statusCode).toBe(409);
    await api.app.db
      .updateTable('bulk_jobs')
      .set({ status: 'cancelled' })
      .where('id', '=', open.id)
      .execute();
    await revert(job.id);
  });

  it('refuses a stale preview', async () => {
    const job = await editAttributes([users.alice, users.bob], { title: 'Tester' });
    const { previewToken } = await previewRevert(job.id);
    await setUserAttribute(SAM.bob, 'title', ['Changed Since']);
    await refresh(users.bob);

    const res = await admin.post(`/api/bulk-jobs/${job.id}/revert`, { previewToken });

    expect(res.statusCode).toBe(409);
    await revert(job.id, { include: 'all' });
    expect(await attribute(SAM.bob, 'title')).toBe(SEEDED.bob.title);
  });
});
