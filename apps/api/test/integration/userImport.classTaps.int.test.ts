// SPDX-License-Identifier: BUSL-1.1
import type {
  BulkJob,
  ClassRoster,
  ClassTapRequest,
  ImportCheckResponse,
  ImportJobResponse,
  ImportRow,
  ImportRunRequest,
} from '@openaduc/shared';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTapGraph, TAP_VALUE } from './fakeGraph.js';
import {
  DC,
  asAdministrator,
  configureDirectory,
  finishedJob,
  setGroupMember,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

// An import that issues Temporary Access Passes for its onboarding class,
// against the dev DC, with Microsoft Graph played by a fake behind fetch.
// The follow-up's timer is stopped; each test sweeps it by hand.

const STAFF_OU = 'OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test';
const DOMAIN_ADMINS = 'CN=Domain Admins,CN=Users,DC=openaduc,DC=test';
const NEW_SAMS = ['cara.cole', 'dev.dunn', 'fay.ford'];
const HOUR = 3_600_000;

const atHour = (ms: number) => new Date(Math.ceil(ms / HOUR) * HOUR).toISOString();

function row(sam: string, line: number, over: Partial<ImportRow> = {}): ImportRow {
  const [first, last] = sam.split('.').map((p) => p[0]!.toUpperCase() + p.slice(1)) as [
    string,
    string,
  ];
  return {
    line,
    ouDn: STAFF_OU,
    givenName: first,
    surname: last,
    displayName: `${first} ${last}`,
    cn: `${first} ${last}`,
    samAccountName: sam,
    userPrincipalName: `${sam}@${DC.domain}`,
    personalEmail: `${first.toLowerCase()}@example.com`,
    mobile: '+44 7700 900123',
    keepPhonesAsTyped: ['mobile'],
    ...over,
  };
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

describe('class Temporary Access Passes', () => {
  let api: TestApi;
  let operator: TestClient;
  let graph: FakeTapGraph;
  let classStart: string;
  let jobId: string;

  const classTap = (over: Partial<ClassTapRequest> = {}): ClassTapRequest => ({
    start: { kind: 'fixed', startsAt: classStart },
    lifetimeMinutes: 240,
    isUsableOnce: false,
    ...over,
  });
  const request = (rows: ImportRow[], tap: ClassTapRequest = classTap()): ImportRunRequest => ({
    import: { rows, password: { mode: 'random' }, enabled: true, mailFromUpn: true, classTap: tap },
  });
  async function runImport(rows: ImportRow[]): Promise<BulkJob> {
    const res = await operator.post('/api/users/import/run', request(rows));
    expect(res.statusCode, res.body).toBe(202);
    return finishedJob(operator, res.json<{ job: BulkJob }>().job.id);
  }
  const roster = async (client = operator, id = jobId) => {
    const res = await client.get(`/api/users/import/jobs/${id}/class-roster`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ClassRoster>();
  };
  const rosterRow = async (sam: string, id = jobId) =>
    (await roster(operator, id)).rows.find((r) => r.samAccountName === sam)!;
  const reveal = (client: TestClient, rowId: string, id = jobId) =>
    client.post(`/api/users/import/jobs/${id}/class-roster/${rowId}/reveal`);
  const sweep = () => api.app.services.classPasses.sweep(5_000);
  /** Sweep with every waiting pass due now, however long its backoff. */
  async function sweepDue(): Promise<void> {
    await api.app.db
      .updateTable('class_passes')
      .set({ next_attempt_at: sql`now()` })
      .where('status', '=', 'waiting')
      .execute();
    await sweep();
  }
  async function sync(sam: string): Promise<string> {
    const user = await api.app.db
      .selectFrom('user_cache_records')
      .select(['sid'])
      .where('sam_account_name', '=', sam)
      .executeTakeFirstOrThrow();
    graph.synced.set(user.sid!, `entra-${sam}`);
    return `entra-${sam}`;
  }
  const passOf = (sam: string) =>
    api.app.db
      .selectFrom('class_passes as p')
      .innerJoin('bulk_job_rows as r', 'r.id', 'p.row_id')
      .selectAll('p')
      .where(sql<string>`r.input_json->>'samAccountName'`, '=', sam)
      .orderBy('p.row_id', 'desc')
      .executeTakeFirstOrThrow();
  const audits = (action: string) =>
    api.app.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', action)
      .orderBy('id')
      .execute();

  beforeAll(async () => {
    await removeNewUsers();
    api = await startApi();
    await configureDirectory(api);
    await api.app.services.classPasses.stop();
    await api.app.services.entraIntegration.create(api.directoryId!, {
      tenantId: '11111111-2222-4333-8444-555555555555',
      clientId: 'client',
      clientSecret: 'not-a-real-secret',
      features: { temporaryAccessPass: true },
    });
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    classStart = atHour(Date.now() + 3 * 24 * HOUR);
    graph = new FakeTapGraph();
  });
  // One tenant for the whole file, as its passes outlive each test; what a
  // test asked of it is forgotten.
  beforeEach(() => {
    graph.requests = [];
    vi.stubGlobal('fetch', graph.fetch);
    api.app.services.graphClient.invalidateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await api?.close();
    await removeNewUsers();
  });

  it('offers class passes within the tenant policy, while the feature is on', async () => {
    const res = await operator.get('/api/users/import/class-taps');
    expect(res.json()).toEqual({
      status: 'ready',
      policy: {
        defaultLifetimeMinutes: 60,
        minLifetimeMinutes: 60,
        maxLifetimeMinutes: 480,
        usableOnceOnly: false,
      },
    });
    await api.app.services.entraIntegration.update(api.directoryId!, {
      features: { temporaryAccessPass: false },
    });
    try {
      expect((await operator.get('/api/users/import/class-taps')).json()).toMatchObject({
        status: 'unavailable',
      });
    } finally {
      await api.app.services.entraIntegration.update(api.directoryId!, {
        features: { temporaryAccessPass: true },
      });
    }
  });

  it('holds the final check to the tenant policy and each row’s start date', async () => {
    graph.policy.isUsableOnce = true;
    const check = await operator.post(
      '/api/users/import/check',
      request([row('cara.cole', 2)]).import,
    );
    expect(check.json<ImportCheckResponse>().problems).toEqual([
      { row: null, kind: 'class', message: 'The tenant’s policy allows only one-time passes.' },
    ]);

    graph.policy.isUsableOnce = false;
    api.app.services.graphClient.invalidateAll();
    const byStartDate = await operator.post(
      '/api/users/import/check',
      request([row('cara.cole', 2, { startDate: classStart.slice(0, 10) }), row('dev.dunn', 3)], {
        ...classTap(),
        start: { kind: 'startDate', time: '09:00', timeZone: 'Europe/London' },
      }).import,
    );
    expect(byStartDate.json<ImportCheckResponse>().problems).toEqual([
      { row: 1, kind: 'class', message: expect.stringContaining('no start date') },
    ]);
  });

  it('waits for sync, then makes each pass to start with class, stored encrypted', async () => {
    const job = await runImport([row('cara.cole', 2), row('dev.dunn', 3)]);
    jobId = job.id;
    expect(job.subject?.import?.classTap).toEqual(classTap());

    await sweep();
    expect(graph.created()).toEqual([]);
    const waiting = await roster();
    expect(waiting).toMatchObject({
      job: { id: jobId, own: true },
      class: { start: { kind: 'fixed', startsAt: classStart }, lifetimeMinutes: 240 },
      lastSyncAt: '2026-10-24T11:30:00.000Z',
      unsyncedAlert: null,
    });
    expect(waiting.rows).toEqual([
      expect.objectContaining({
        line: 2,
        displayName: 'Cara Cole',
        samAccountName: 'cara.cole',
        personalEmail: 'cara@example.com',
        mobile: expect.stringContaining('7700'),
        status: 'waitingForSync',
        startsAt: classStart,
        held: false,
      }),
      expect.objectContaining({ samAccountName: 'dev.dunn', status: 'waitingForSync' }),
    ]);

    const cara = await sync('cara.cole');
    await sweepDue();
    expect(graph.created()).toEqual([
      {
        entraUserId: cara,
        body: { startDateTime: classStart, lifetimeInMinutes: 240, isUsableOnce: false },
      },
    ]);
    const stored = await passOf('cara.cole');
    expect(stored).toMatchObject({ status: 'issued', entra_user_id: cara });
    expect(stored.pass_enc).toMatch(/^v1\./);
    expect(stored.pass_enc).not.toContain(TAP_VALUE);

    const issued = await roster();
    expect(issued.rows.map((r) => [r.samAccountName, r.status, r.held])).toEqual([
      ['cara.cole', 'notYetValid', true],
      ['dev.dunn', 'waitingForSync', false],
    ]);

    const [event] = await audits('import.classPass.issue');
    expect(event).toMatchObject({
      result: 'success',
      actor_auth_method: 'system',
      actor_user_id: (await api.app.db
        .selectFrom('bulk_jobs')
        .select('actor_user_id')
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow())!.actor_user_id,
      bulk_job_id: jobId,
      target_id: issued.rows[0]!.id,
    });
    expect(JSON.stringify(event)).not.toContain(TAP_VALUE);
  });

  it('lets any operator who may issue a TAP reveal a pass after step-up, auditing each', async () => {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    const theirs = await roster(admin);
    expect(theirs.job.own).toBe(false);
    const cara = theirs.rows.find((r) => r.samAccountName === 'cara.cole')!;

    expect((await reveal(admin, cara.rowId)).json()).toMatchObject({
      error: { code: 'step_up_required' },
    });
    await admin.stepUp();
    const revealed = await reveal(admin, cara.rowId);
    expect(revealed.statusCode, revealed.body).toBe(200);
    expect(revealed.headers['cache-control']).toBe('no-store');
    expect(revealed.json()).toEqual({
      temporaryAccessPass: TAP_VALUE,
      startsAt: classStart,
      expiresAt: new Date(Date.parse(classStart) + 4 * HOUR).toISOString(),
      isUsableOnce: false,
    });

    const events = await audits('import.classPass.reveal');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'success', target_id: cara.id, bulk_job_id: jobId });
    expect(JSON.stringify(events)).not.toContain(TAP_VALUE);

    const auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    expect((await auditor.get(`/api/users/import/jobs/${jobId}/class-roster`)).statusCode).toBe(
      403,
    );
  });

  it('alerts on the job when someone is still unsynced shortly before class', async () => {
    const dev = await passOf('dev.dunn');
    const soon = new Date(Date.now() + HOUR).toISOString();
    await api.app.db
      .updateTable('class_passes')
      .set({ class_starts_at: soon })
      .where('row_id', '=', dev.row_id)
      .execute();
    try {
      expect((await roster()).unsyncedAlert).toEqual({ count: 1, startsAt: soon });
      const page = (
        await operator.get(`/api/users/import/jobs/${jobId}`)
      ).json<ImportJobResponse>();
      expect(page.classTap).toEqual({ unsyncedAlert: { count: 1, startsAt: soon } });
    } finally {
      await api.app.db
        .updateTable('class_passes')
        .set({ class_starts_at: classStart })
        .where('row_id', '=', dev.row_id)
        .execute();
    }
  });

  it('reissues a lost pass, replacing the one held, and audits it', async () => {
    const cara = await rosterRow('cara.cole');
    const res = await operator.post(
      `/api/users/import/jobs/${jobId}/class-roster/${cara.rowId}/reissue`,
    );
    expect(res.json()).toEqual({ outcome: 'issued', message: null });
    expect(graph.created()).toHaveLength(1);
    const value = graph.values.at(-1);
    expect(value).not.toBe(TAP_VALUE);
    expect((await reveal(operator, cara.rowId)).json()).toMatchObject({
      temporaryAccessPass: value,
    });
    const [event] = await audits('import.classPass.reissue');
    expect(event).toMatchObject({
      result: 'success',
      actor_auth_method: 'ad-password',
      target_id: cara.id,
    });
  });

  it('reschedules class: every pass made again for the new start, the old values deleted', async () => {
    const moved = atHour(Date.now() + 5 * 24 * HOUR);
    const res = await operator.post(`/api/users/import/jobs/${jobId}/class-roster/reschedule`, {
      start: { kind: 'fixed', startsAt: moved },
    });
    expect(res.statusCode, res.body).toBe(204);
    expect(await passOf('cara.cole')).toMatchObject({
      status: 'waiting',
      pass_enc: null,
      class_starts_at: new Date(moved),
    });
    const [event] = await audits('import.class.reschedule');
    expect(event).toMatchObject({
      result: 'success',
      before_json: { start: { kind: 'fixed', startsAt: classStart } },
      after_json: { start: { kind: 'fixed', startsAt: moved } },
    });

    const cara = await sync('cara.cole');
    const dev = await sync('dev.dunn');
    await sweepDue();
    expect(graph.created().map((c) => [c.entraUserId, c.body['startDateTime']])).toEqual(
      expect.arrayContaining([
        [cara, moved],
        [dev, moved],
      ]),
    );
    const after = await roster();
    expect(after.class.start).toEqual({ kind: 'fixed', startsAt: moved });
    expect(after.rows.map((r) => [r.status, r.held, r.startsAt])).toEqual([
      ['notYetValid', true, moved],
      ['notYetValid', true, moved],
    ]);

    const past = await operator.post(`/api/users/import/jobs/${jobId}/class-roster/reschedule`, {
      start: { kind: 'fixed', startsAt: new Date(Date.now() - HOUR).toISOString() },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({ error: { message: 'Class starts in the past.' } });
  });

  it('stops holding a pass replaced outside the roster', async () => {
    const [current] = graph.passes.get('entra-cara.cole')!;
    graph.passes.set('entra-cara.cole', [{ ...current!, id: 'made-in-the-portal' }]);
    expect(await rosterRow('cara.cole')).toMatchObject({ status: 'replaced', held: false });
    expect(await passOf('cara.cole')).toMatchObject({ status: 'issued', pass_enc: null });
  });

  it('deletes a pass’s value once it expires', async () => {
    const dev = await passOf('dev.dunn');
    await api.app.db
      .updateTable('class_passes')
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where('row_id', '=', dev.row_id)
      .execute();
    await sweep();
    expect(await passOf('dev.dunn')).toMatchObject({ status: 'issued', pass_enc: null });
    const res = await reveal(operator, String(dev.row_id));
    expect(res.statusCode).toBe(410);
    expect(await rosterRow('dev.dunn')).toMatchObject({ status: 'expired', held: false });
    expect(await audits('import.classPass.reveal')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: 'failure', error_code: 'not_held' }),
      ]),
    );
  });

  it('refuses a pass to an administrator, with the reason', async () => {
    const job = await runImport([row('fay.ford', 2)]);
    await setGroupMember(DOMAIN_ADMINS, 'fay.ford', true);
    await sync('fay.ford');
    await sweepDue();
    expect(graph.created()).toEqual([]);
    expect(await rosterRow('fay.ford', job.id)).toMatchObject({
      status: 'refused',
      held: false,
      message: expect.stringContaining('member of Domain Admins'),
    });
    expect(
      (await audits('import.classPass.issue')).filter((e) => e.bulk_job_id === job.id),
    ).toEqual([expect.objectContaining({ result: 'failure', error_code: 'privileged' })]);
  });

  it('waits out Graph throttling, holding back the directory’s passes as asked', async () => {
    const cara = await passOf('cara.cole');
    await api.app.db
      .updateTable('class_passes')
      .set({ status: 'waiting', pass_enc: null })
      .where('row_id', '=', cara.row_id)
      .execute();
    graph.throttled = { path: /^\/users$/, retryAfter: 120 };
    await sweepDue();
    const throttled = await passOf('cara.cole');
    expect(throttled).toMatchObject({ status: 'waiting', error_code: 'entra_throttled' });
    expect(new Date(throttled.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 100_000);
    expect(await rosterRow('cara.cole')).toMatchObject({
      status: 'retrying',
      message: 'Microsoft Graph is busy.',
    });

    const asked = graph.requests.length;
    await sweepDue();
    expect(graph.requests.length).toBe(asked);
  });
});
