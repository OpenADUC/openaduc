// SPDX-License-Identifier: BUSL-1.1
import { readFileSync } from 'node:fs';
import type {
  BulkJob,
  ImportJobResponse,
  ImportRequest,
  ImportResultsDownload,
  ImportRow,
  ImportRunRequest,
} from '@openaduc/shared';
import { Client as LdapClient } from 'ldapts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DC,
  asAdministrator,
  configureDirectory,
  finishedJob,
  readDirectoryUser,
  setGroupMember,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const STAFF_OU = 'OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test';
const DOMAIN_GUESTS = 'CN=Domain Guests,CN=Users,DC=openaduc,DC=test';
const NEW_SAMS = [
  'ivy.ingram',
  'kit.kemp',
  'max.mendez',
  'gus.grant',
  'hal.hayes',
  'ray.rand',
  'ona.oates',
];
const SHARED_PASSWORD = 'Shared-start-Pass7';

function row(sam: string, over: Partial<ImportRow> = {}): ImportRow {
  const [first, last] = sam.split('.').map((p) => p[0]!.toUpperCase() + p.slice(1)) as [
    string,
    string,
  ];
  return {
    line: 2,
    ouDn: STAFF_OU,
    givenName: first,
    surname: last,
    displayName: `${first} ${last}`,
    cn: `${first} ${last}`,
    samAccountName: sam,
    userPrincipalName: `${sam}@${DC.domain}`,
    ...over,
  };
}

const request = (rows: ImportRow[], over: Partial<ImportRequest> = {}): ImportRunRequest => ({
  import: { rows, password: { mode: 'random' }, enabled: true, mailFromUpn: true, ...over },
});

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

describe('running an import', () => {
  let api: TestApi;
  let operator: TestClient;
  let engineering: string;
  let domainGuests: string;

  const groupId = async (name: string) =>
    (await operator.get(`/api/groups?q=${encodeURIComponent(name)}`))
      .json<{ rows: { id: string; name: string }[] }>()
      .rows.find((g) => g.name === name)!.id;

  async function run(body: ImportRunRequest): Promise<BulkJob> {
    const res = await operator.post('/api/users/import/run', body);
    expect(res.statusCode, res.body).toBe(202);
    return res.json<{ job: BulkJob }>().job;
  }
  const view = async (id: string, client = operator) => {
    const res = await client.get(`/api/users/import/jobs/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ImportJobResponse>();
  };
  const download = (id: string, client = operator) =>
    client.post(`/api/users/import/jobs/${id}/results`);
  const audits = (where: { action?: string; targetId?: string; bulkJobId?: string }) => {
    let q = api.app.db
      .selectFrom('audit_events')
      .select(['id', 'action', 'result', 'target_id', 'metadata_json', 'before_json', 'after_json'])
      .orderBy('id');
    if (where.action) q = q.where('action', '=', where.action);
    if (where.targetId) q = q.where('target_id', '=', where.targetId);
    if (where.bulkJobId) q = q.where('bulk_job_id', '=', where.bulkJobId);
    return q.execute();
  };
  const heldPasswords = async (jobId: string) =>
    Number(
      (
        await api.app.db
          .selectFrom('import_passwords')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('job_id', '=', jobId)
          .executeTakeFirstOrThrow()
      ).n,
    );

  beforeAll(async () => {
    await removeNewUsers();
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    engineering = await groupId('Engineering');
    domainGuests = await groupId('Domain Guests');
  });

  afterAll(async () => {
    await api?.close();
    await removeNewUsers();
  });

  it('leaves a row partial when a later step fails, and its retry runs only what’s missing', async () => {
    const queued = await run(request([row('ivy.ingram', { groups: [engineering, domainGuests] })]));
    expect(queued).toMatchObject({ action: 'user.create', revertible: false });

    const job = await finishedJob(operator, queued.id);
    expect(job).toMatchObject({ status: 'finished', counts: { total: 1, partial: 1 } });
    const [partial] = (await view(job.id)).rows;
    // Domain Guests is outside the OU the operator may write.
    expect(partial).toMatchObject({
      status: 'partial',
      samAccountName: 'ivy.ingram',
      userPrincipalName: `ivy.ingram@${DC.domain}`,
      id: expect.any(String),
      completed: ['create', 'password', 'enable', 'manager'],
      failed: [
        {
          step: 'groups',
          message: expect.stringMatching(
            /^Added to Engineering\. Not added to Domain Guests: the directory refused the change/,
          ),
        },
      ],
    });
    const entry = await readDirectoryUser('ivy.ingram', ['userAccountControl', 'memberOf']);
    expect(entry?.userAccountControl).toBe('512');
    expect(String(entry?.memberOf)).toContain('CN=Engineering');

    // In the cache at once.
    const listed = await operator.get('/api/users?q=ivy.ingram');
    expect(listed.json<{ rows: { id: string }[] }>().rows.map((r) => r.id)).toEqual([partial!.id]);

    // Whoever manages Domain Guests adds her meanwhile; the retry finds it done.
    await setGroupMember(DOMAIN_GUESTS, 'ivy.ingram', true);
    const retried = await operator.post(`/api/bulk-jobs/${job.id}/retry`);
    expect(retried.statusCode, retried.body).toBe(200);
    const after = await finishedJob(operator, job.id);
    expect(after.counts).toMatchObject({ succeeded: 1, partial: 0 });
    expect((await view(job.id)).rows[0]).toMatchObject({
      status: 'succeeded',
      id: partial!.id,
      completed: ['create', 'password', 'enable', 'groups', 'manager'],
      failed: [],
    });

    // Created once: the retry made no second create, and asked nothing more of Engineering.
    const events = await audits({ targetId: partial!.id! });
    expect(events.filter((e) => e.action === 'user.create')).toHaveLength(1);
    const groupAdds = events.filter((e) => e.action === 'user.group.add');
    expect(groupAdds.map((e) => [e.metadata_json?.['groupName'], e.result])).toEqual([
      ['Engineering', 'success'],
      ['Domain Guests', 'failure'],
      ['Domain Guests', 'success'],
    ]);
  });

  it('doesn’t create an account twice when the run stopped before recording its row', async () => {
    const queued = await run(request([row('ona.oates')]));
    const job = await finishedJob(operator, queued.id);
    expect(job.counts.succeeded).toBe(1);
    // As the sweep leaves a row whose run died mid-way.
    await api.app.db
      .updateTable('bulk_job_rows')
      .set({ status: 'failed', error_code: 'interrupted', after_json: null, target_id: null })
      .where('job_id', '=', job.id)
      .execute();

    expect((await operator.post(`/api/bulk-jobs/${job.id}/retry`)).statusCode).toBe(200);
    const after = await finishedJob(operator, job.id);

    expect(after.counts).toMatchObject({ succeeded: 1, failed: 0 });
    const [ona] = (await view(job.id)).rows;
    expect(ona).toMatchObject({ status: 'succeeded', id: expect.any(String) });
    expect(await audits({ action: 'user.create', bulkJobId: job.id })).toHaveLength(1);
  });

  it('creates a manager the import also creates before the people they manage', async () => {
    const queued = await run(
      request([
        row('kit.kemp', { line: 2, managerRow: 1 }),
        row('max.mendez', { line: 3, employeeId: 'E-7001', description: 'Starts Monday' }),
      ]),
    );
    const job = await finishedJob(operator, queued.id);
    expect(job.counts).toMatchObject({ total: 2, succeeded: 2 });

    const [kit, max] = (await view(job.id)).rows;
    expect([kit!.samAccountName, max!.samAccountName]).toEqual(['kit.kemp', 'max.mendez']);
    const creates = await audits({ action: 'user.create', bulkJobId: job.id });
    expect(creates.map((c) => c.target_id)).toEqual([max!.id, kit!.id]);
    const report = await readDirectoryUser('kit.kemp', ['manager']);
    expect(String(report?.manager)).toMatch(/^CN=Max Mendez,OU=Staff/);
    expect(await readDirectoryUser('max.mendez', ['employeeID', 'description'])).toMatchObject({
      employeeID: 'E-7001',
      description: 'Starts Monday',
    });

    // Random mode: the CSV has no passwords, and can be downloaded again.
    const res = await download(job.id);
    expect(res.statusCode, res.body).toBe(200);
    const { csv } = res.json<ImportResultsDownload>();
    expect(csv.split('\r\n')[0]).toBe('Row,Status,Display name,Username,UPN,Problems');
    expect(csv).toContain(`2,Created,Kit Kemp,kit.kemp,kit.kemp@${DC.domain},`);
    expect((await download(job.id)).statusCode).toBe(200);
  });

  it('hands out generated passwords in a CSV downloaded once, by its operator, then purged', async () => {
    const queued = await run(
      request([row('gus.grant')], { password: { mode: 'generate', mustChange: false } }),
    );
    const job = await finishedJob(operator, queued.id);
    expect(job.counts.succeeded).toBe(1);
    expect((await view(job.id)).results).toMatchObject({
      passwords: 'held',
      downloadedAt: null,
      expiresAt: expect.any(String),
    });
    expect(await heldPasswords(job.id)).toBe(1);

    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    await admin.stepUp();
    expect((await download(job.id, admin)).statusCode).toBe(404);

    const res = await download(job.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const [header, line] = res.json<ImportResultsDownload>().csv.split('\r\n');
    expect(header).toBe(
      'Row,Status,Display name,Username,UPN,Password,Must change password,Problems',
    );
    const password = line!.split(',')[5]!;
    expect(password.length).toBeGreaterThanOrEqual(16);
    expect(await canBind(`gus.grant@${DC.domain}`, password)).toBe(true);

    expect(await heldPasswords(job.id)).toBe(0);
    const again = await download(job.id);
    expect(again.statusCode).toBe(409);
    expect((await view(job.id)).results).toMatchObject({
      passwords: 'downloaded',
      downloadedAt: expect.any(String),
    });

    const events = await audits({ bulkJobId: job.id });
    expect(events.filter((e) => e.action === 'import.results.download')).toEqual([
      expect.objectContaining({
        result: 'success',
        metadata_json: expect.objectContaining({ passwords: true }),
      }),
    ]);
    const records = await api.app.db
      .selectFrom('bulk_job_rows')
      .select(['input_json', 'after_json', 'error_message'])
      .where('job_id', '=', job.id)
      .execute();
    expect(JSON.stringify([events, records])).not.toContain(password);
  });

  it('purges a shared password unseen after 24 hours', async () => {
    const queued = await run(
      request([row('hal.hayes')], {
        password: { mode: 'set', password: SHARED_PASSWORD, mustChange: true },
      }),
    );
    const job = await finishedJob(operator, queued.id);
    expect(job.counts.succeeded).toBe(1);
    expect(await heldPasswords(job.id)).toBe(1);
    const records = await api.app.db
      .selectFrom('bulk_jobs')
      .innerJoin('bulk_job_rows', 'bulk_job_rows.job_id', 'bulk_jobs.id')
      .select(['subject_json', 'input_json'])
      .where('bulk_jobs.id', '=', job.id)
      .execute();
    expect(JSON.stringify([records, await audits({ bulkJobId: job.id })])).not.toContain(
      SHARED_PASSWORD,
    );

    await api.app.db
      .updateTable('bulk_jobs')
      .set({ created_at: sql`now() - interval '25 hours'` })
      .where('id', '=', job.id)
      .execute();
    await api.app.db
      .updateTable('import_passwords')
      .set({ expires_at: sql`now() - interval '1 hour'` })
      .where('job_id', '=', job.id)
      .execute();
    await api.app.services.bulkJobs.purgeExpiredPasswords();

    expect(await heldPasswords(job.id)).toBe(0);
    expect((await view(job.id)).results.passwords).toBe('expired');
    expect((await download(job.id)).statusCode).toBe(410);
  });

  it('runs only what the final check passes, and can’t be reverted', async () => {
    const taken = await operator.post(
      '/api/users/import/run',
      request([row('ray.rand', { samAccountName: 'alice.anders' })]),
    );
    expect(taken.statusCode).toBe(422);
    expect(taken.json()).toMatchObject({
      error: { message: expect.stringMatching(/alice\.anders.*Run the final check again\./) },
    });
    expect(await readDirectoryUser('ray.rand', ['cn'])).toBeNull();

    const [done] = (await operator.get('/api/bulk-jobs?limit=1')).json<{ jobs: BulkJob[] }>().jobs;
    const revert = await operator.get(`/api/bulk-jobs/${done!.id}/revert/preview`);
    expect(revert.statusCode).toBe(422);
    expect(revert.json()).toMatchObject({
      error: { message: expect.stringMatching(/An import can’t be reverted/) },
    });

    const fresh = api.client();
    await fresh.signIn(api, 'oa.operator');
    expect(
      (await fresh.post('/api/users/import/run', request([row('ray.rand')]))).json(),
    ).toMatchObject({ error: { code: 'step_up_required' } });
  });
});
