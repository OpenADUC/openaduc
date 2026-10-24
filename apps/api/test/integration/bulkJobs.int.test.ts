// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditBulkSummary, BulkJob, BulkJobRow } from '@openaduc/shared';
import {
  configureDirectory,
  readDirectoryUser,
  reseedDirectory,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

interface AuditRow {
  action: string;
  result: string;
  targetId: string | null;
  bulkJobId: string | null;
  bulk: AuditBulkSummary | null;
}

const isDisabled = async (sam: string) =>
  (Number((await readDirectoryUser(sam, ['userAccountControl']))?.userAccountControl) & 0x2) !== 0;

describe('bulk actions run as server-side jobs', () => {
  let api: TestApi;
  let operator: TestClient;
  let auditor: TestClient;
  let users: Record<'alice' | 'bob' | 'carol' | 'dave' | 'guest', string>;

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    const id = async (q: string) =>
      (await operator.get(`/api/users?q=${q}`))
        .json<{
          rows: { id: string; samAccountName: string }[];
        }>()
        .rows.find((r) => r.samAccountName.toLowerCase() === q.toLowerCase())!.id;
    users = {
      alice: await id('alice.anders'),
      bob: await id('bob.baker'),
      carol: await id('carol.chen'),
      dave: await id('dave.diaz'),
      // Outside the OU oa.operator may change.
      guest: await id('Guest'),
    };
  });

  afterAll(async () => {
    await api?.close();
    reseedDirectory();
  });

  async function waitFor(
    client: TestClient,
    id: string,
    done: (job: BulkJob) => boolean,
  ): Promise<BulkJob> {
    for (let i = 0; i < 300; i++) {
      const res = await client.get(`/api/bulk-jobs/${id}`);
      expect(res.statusCode).toBe(200);
      const { job } = res.json<{ job: BulkJob }>();
      if (done(job)) return job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`bulk job ${id} didn't get there`);
  }
  const stopped = (job: BulkJob) => job.status !== 'queued' && job.status !== 'running';

  async function start(action: string, ids: string[], client = operator): Promise<BulkJob> {
    const res = await client.post(`/api/users/bulk-${action}`, { ids });
    expect(res.statusCode).toBe(202);
    return res.json<{ job: BulkJob }>().job;
  }

  const failedRows = async (id: string) =>
    (await operator.get(`/api/bulk-jobs/${id}/rows?status=failed`)).json<{ rows: BulkJobRow[] }>()
      .rows;

  const jobEvents = async (id: string) =>
    (await auditor.get(`/api/audit-events?bulkJobId=${id}&pageSize=200`)).json<{
      rows: AuditRow[];
    }>().rows;

  it('writes each row, keeps going past failures, and says why each failed', async () => {
    const missing = randomUUID();
    const queued = await start('enable', [users.carol, users.guest, missing]);
    expect(queued.counts.total).toBe(3);

    const job = await waitFor(operator, queued.id, stopped);

    expect(job).toMatchObject({
      action: 'user.enable',
      status: 'finished',
      counts: { total: 3, succeeded: 1, failed: 2, pending: 0 },
    });
    expect(await isDisabled('carol.chen')).toBe(false);
    expect(await isDisabled('Guest')).toBe(true);
    const failed = await failedRows(job.id);
    expect(failed.map((r) => [r.targetId, r.errorCode])).toEqual([
      [users.guest, 'permission_denied'],
      [missing, 'not_found'],
    ]);
    expect(failed[0]!.targetName).toBe('Guest');
    expect(failed[0]!.errorMessage).toMatch(/^The directory refused the change/);
    expect(failed[1]!.errorMessage).toBe('No such user in the directory.');
  });

  it('audits every row with the bulk id, and the audit log shows the job as one entry', async () => {
    const missing = randomUUID();
    const job = await waitFor(
      operator,
      (await start('disable', [users.alice, users.bob, missing])).id,
      stopped,
    );

    const events = await jobEvents(job.id);
    const [heading, ...rows] = events.map((e) => [e.action, e.result, e.targetId]).reverse();
    expect(heading).toEqual(['bulk.create', 'success', null]);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['user.disable', 'success', users.alice],
        ['user.disable', 'success', users.bob],
        ['user.disable', 'failure', missing],
      ]),
    );
    expect(events.every((e) => e.bulkJobId === job.id)).toBe(true);

    // Grouped, and found by a row's failure as well as by its heading.
    for (const query of ['groupBulk=1', 'groupBulk=1&result=failure&action=user.disable']) {
      const grouped = (await auditor.get(`/api/audit-events?${query}&pageSize=200`)).json<{
        rows: AuditRow[];
      }>().rows;
      expect(grouped.filter((e) => e.bulkJobId === job.id)).toEqual([
        expect.objectContaining({
          action: 'bulk.create',
          bulk: {
            action: 'user.disable',
            subject: null,
            status: 'finished',
            pauseReason: null,
            total: 3,
            counts: { total: 3, pending: 0, running: 0, succeeded: 2, failed: 1, skipped: 0 },
          },
        }),
      ]);
    }
    // Ungrouped, as a user's own activity reads it, each row stands alone.
    const flat = (
      await auditor.get(`/api/audit-events?targetType=user&targetId=${users.alice}`)
    ).json<{ rows: AuditRow[] }>().rows;
    expect(flat[0]).toMatchObject({ action: 'user.disable', bulkJobId: job.id });

    await waitFor(operator, (await start('enable', [users.alice, users.bob])).id, stopped);
  });

  it('retries only the failed rows, under the same bulk id', async () => {
    const missing = randomUUID();
    const first = await waitFor(
      operator,
      (await start('unlock', [users.dave, missing])).id,
      stopped,
    );
    expect(first.counts).toMatchObject({ succeeded: 1, failed: 1 });

    const res = await operator.post(`/api/bulk-jobs/${first.id}/retry`);
    expect(res.statusCode).toBe(200);
    const retried = await waitFor(operator, first.id, (j) => stopped(j) && j.counts.pending === 0);

    expect(retried.counts).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    const events = await jobEvents(first.id);
    expect(events.filter((e) => e.targetId === users.dave)).toHaveLength(1);
    expect(events.filter((e) => e.targetId === missing)).toHaveLength(2);
    expect(events.map((e) => e.action)).toContain('bulk.retry');
    const attempts = await api.app.db
      .selectFrom('bulk_job_rows')
      .select(['target_id', 'attempts'])
      .where('job_id', '=', first.id)
      .orderBy('ordinal')
      .execute();
    expect(attempts.map((r) => r.attempts)).toEqual([1, 2]);
  });

  it('pauses when the elevated session ends, and continues after a step-up', async () => {
    // Enough rows that the step-down lands before the job is through them.
    const ids = Array.from({ length: 300 }, () => randomUUID());
    const queued = await start('disable', ids);
    expect((await operator.delete('/api/auth/step-up')).statusCode).toBe(200);

    const paused = await waitFor(operator, queued.id, stopped);
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'step_up_required' });
    expect(paused.counts.pending).toBeGreaterThan(0);
    const pending = paused.counts.pending;
    await new Promise((r) => setTimeout(r, 300));
    expect((await waitFor(operator, queued.id, stopped)).counts.pending).toBe(pending);

    const refused = await operator.post(`/api/bulk-jobs/${queued.id}/resume`);
    expect(refused.json()).toMatchObject({ error: { code: 'step_up_required' } });

    await operator.stepUp();
    expect((await operator.post(`/api/bulk-jobs/${queued.id}/resume`)).statusCode).toBe(200);
    const finished = await waitFor(operator, queued.id, stopped);
    expect(finished).toMatchObject({ status: 'finished', counts: { pending: 0, failed: 300 } });
    const lifecycle = await api.app.db
      .selectFrom('audit_events')
      .select(['action', 'metadata_json'])
      .where('bulk_job_id', '=', queued.id)
      .where('action', 'like', 'bulk.%')
      .orderBy('id')
      .execute();
    expect(lifecycle.map((e) => e.action)).toEqual(['bulk.create', 'bulk.pause', 'bulk.resume']);
    expect(lifecycle[1]!.metadata_json).toMatchObject({ reason: 'step_up_required' });
  });

  it('stops a job, skipping the rows it hadn’t reached', async () => {
    const queued = await start(
      'disable',
      Array.from({ length: 300 }, () => randomUUID()),
    );
    const res = await operator.post(`/api/bulk-jobs/${queued.id}/cancel`);
    expect(res.statusCode).toBe(200);

    const job = await waitFor(operator, queued.id, (j) => stopped(j) && j.counts.running === 0);
    expect(job.status).toBe('cancelled');
    expect(job.counts.skipped).toBeGreaterThan(0);
    expect(job.counts.skipped + job.counts.failed).toBe(300);
  });

  it('leaves a job its process lost paused, with the row in flight failed and retryable', async () => {
    const job = await waitFor(operator, (await start('enable', [users.alice])).id, stopped);
    // As a crashed process leaves it: running, with a row in flight.
    await api.app.db
      .updateTable('bulk_jobs')
      .set({ status: 'running', heartbeat_at: new Date(Date.now() - 5 * 60_000) })
      .where('id', '=', job.id)
      .execute();
    await api.app.db
      .updateTable('bulk_job_rows')
      .set({ status: 'running' })
      .where('job_id', '=', job.id)
      .execute();

    await api.app.services.bulkJobs.recoverStale();

    const recovered = await waitFor(operator, job.id, stopped);
    expect(recovered).toMatchObject({
      status: 'paused',
      pauseReason: 'interrupted',
      counts: { failed: 1 },
    });
    expect((await failedRows(job.id))[0]).toMatchObject({ errorCode: 'interrupted' });
    expect((await operator.post(`/api/bulk-jobs/${job.id}/retry`)).statusCode).toBe(200);
    expect(await waitFor(operator, job.id, stopped)).toMatchObject({
      status: 'finished',
      counts: { succeeded: 1, failed: 0 },
    });
  });

  it('lists the operator’s own jobs, newest first, and no one else’s', async () => {
    const mine = (await operator.get('/api/bulk-jobs?limit=2')).json<{ jobs: BulkJob[] }>().jobs;
    expect(mine).toHaveLength(2);
    expect(Number(mine[0]!.id)).toBeGreaterThan(Number(mine[1]!.id));

    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    expect((await admin.get('/api/bulk-jobs')).json<{ jobs: BulkJob[] }>().jobs).toEqual([]);
    expect((await admin.get(`/api/bulk-jobs/${mine[0]!.id}`)).statusCode).toBe(404);
    expect((await admin.post(`/api/bulk-jobs/${mine[0]!.id}/cancel`)).statusCode).toBe(404);
  });

  it('takes the action’s capability and a step-up to start', async () => {
    await auditor.stepUp();
    expect((await auditor.post('/api/users/bulk-disable', { ids: [users.bob] })).statusCode).toBe(
      403,
    );

    const unelevated = api.client();
    await unelevated.signIn(api, 'oa.operator');
    const res = await unelevated.post('/api/users/bulk-unlock', { ids: [users.bob] });
    expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });
    expect(
      (await operator.post('/api/users/bulk-unlock', { ids: [users.bob, users.bob] })).statusCode,
    ).toBe(400);
  });
});
