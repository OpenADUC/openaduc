// SPDX-License-Identifier: BUSL-1.1
// What an import's job does when the directory doesn't answer as asked:
// a create it can't read back, one that landed without its records, a
// manager's row that fails, a password set after the CSV was downloaded;
// and the password reset an import's results page offers. The directory
// is made to misbehave by wrapping the provider the job builds.
import type {
  BulkJob,
  BulkJobResultsDownload,
  ImportJobResponse,
  ImportRequest,
  ImportRow,
  ImportRunRequest,
} from '@openaduc/shared';
import { parseTable } from '@openaduc/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DirectoryProvider } from '../../src/providers/types.js';
import {
  DC,
  asAdministrator,
  configureDirectory,
  finishedJob,
  readDirectoryUser,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const STAFF_OU = 'OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test';
const NEW_SAMS = ['una.unread', 'vic.vane', 'wes.west', 'xan.xu', 'yul.yates', 'zed.zane'];

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

describe('an import when the directory misbehaves', () => {
  let api: TestApi;
  let operator: TestClient;
  let engineering: string;

  /** Replace some of the provider's methods, given the real provider, for the jobs that run next. */
  function tamper(make: (real: DirectoryProvider) => Partial<DirectoryProvider>) {
    const providers = api.app.services.providers;
    const original = providers.buildForDirectory.bind(providers);
    return vi.spyOn(providers, 'buildForDirectory').mockImplementation(async (id) => {
      const real = await original(id);
      const over = make(real) as Record<PropertyKey, unknown>;
      return new Proxy(real, {
        get(target, key) {
          if (key in over) return over[key];
          const value = Reflect.get(target, key) as unknown;
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
    });
  }

  async function run(body: ImportRunRequest): Promise<BulkJob> {
    const res = await operator.post('/api/users/import/run', body);
    expect(res.statusCode, res.body).toBe(202);
    return res.json<{ job: BulkJob }>().job;
  }
  const view = async (id: string) => {
    const res = await operator.get(`/api/users/import/jobs/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ImportJobResponse>();
  };
  const retry = async (id: string) => {
    const res = await operator.post(`/api/bulk-jobs/${id}/retry`);
    expect(res.statusCode, res.body).toBe(200);
    return finishedJob(operator, id);
  };
  const audits = (bulkJobId: string, action?: string) => {
    let q = api.app.db
      .selectFrom('audit_events')
      .select(['id', 'action', 'result', 'target_id', 'metadata_json'])
      .where('bulk_job_id', '=', bulkJobId)
      .orderBy('id');
    if (action) q = q.where('action', '=', action);
    return q.execute();
  };
  const inGroup = async (sam: string, group: string) =>
    String((await readDirectoryUser(sam, ['memberOf']))?.memberOf ?? '').includes(`CN=${group}`);

  beforeAll(async () => {
    await removeNewUsers();
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    engineering = (await operator.get('/api/groups?q=Engineering'))
      .json<{ rows: { id: string; name: string }[] }>()
      .rows.find((g) => g.name === 'Engineering')!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await api?.close();
    await removeNewUsers();
  });

  it('finds a new account it couldn’t read back, finishes it and caches it', async () => {
    let blind = 1;
    tamper((real) => ({
      createUser: async (...args: Parameters<DirectoryProvider['createUser']>) => {
        const { user: _, fingerprint: __, ...r } = await real.createUser(...args);
        return r;
      },
      getUser: async (id) => {
        if (
          id.kind === 'distinguishedName' &&
          id.value.startsWith('CN=Una Unread') &&
          blind-- > 0
        ) {
          return null;
        }
        return real.getUser(id);
      },
      getAccountFingerprint: async () => null,
    }));
    const job = await finishedJob(
      operator,
      (await run(request([row('una.unread', { groups: [engineering] })]))).id,
    );

    expect(job.counts).toMatchObject({ succeeded: 1, partial: 0 });
    const [una] = (await view(job.id)).rows;
    expect(una).toMatchObject({ status: 'succeeded', id: expect.any(String), failed: [] });
    expect(await inGroup('una.unread', 'Engineering')).toBe(true);
    const listed = await operator.get('/api/users?q=una.unread');
    expect(listed.json<{ rows: { id: string }[] }>().rows.map((r) => r.id)).toEqual([una!.id]);
  });

  it('leaves a row partial, naming what’s left, when the new account can’t be found', async () => {
    const hidden = (id: { kind: string; value: string }) =>
      (id.kind === 'distinguishedName' && id.value.startsWith('CN=Vic Vane')) ||
      (id.kind === 'samAccountName' && id.value === 'vic.vane');
    tamper((real) => ({
      createUser: async (...args: Parameters<DirectoryProvider['createUser']>) => {
        const { user: _, fingerprint: __, ...r } = await real.createUser(...args);
        return r;
      },
      getUser: async (id) => (hidden(id) ? null : real.getUser(id)),
      getAccountFingerprint: async () => null,
    }));
    const job = await finishedJob(
      operator,
      (await run(request([row('vic.vane', { groups: [engineering] })]))).id,
    );

    expect(job.counts).toMatchObject({ succeeded: 0, partial: 1 });
    const [vic] = (await view(job.id)).rows;
    expect(vic).toMatchObject({
      status: 'partial',
      id: null,
      completed: ['create', 'password', 'enable', 'manager'],
      failed: [{ step: 'groups', message: expect.stringMatching(/couldn’t be read back/) }],
    });
    expect(await inGroup('vic.vane', 'Engineering')).toBe(false);

    vi.restoreAllMocks();
    const after = await retry(job.id);
    expect(after.counts).toMatchObject({ succeeded: 1, partial: 0 });
    expect((await view(job.id)).rows[0]).toMatchObject({
      status: 'succeeded',
      id: expect.any(String),
    });
    expect(await inGroup('vic.vane', 'Engineering')).toBe(true);
    expect(await audits(job.id, 'user.create')).toHaveLength(1);
  });

  it('takes on, on a retry, the account a run created without recording it', async () => {
    tamper((real) => ({
      // The add lands, then the run dies before the rest, unrecorded.
      createUser: async (input, _steps, finish, ctx) => {
        await real.createUser(input, ['create'], finish, ctx);
        throw new Error('the process stopped');
      },
    }));
    const job = await finishedJob(operator, (await run(request([row('wes.west')]))).id);
    expect(job.counts).toMatchObject({ failed: 1 });
    expect(
      Number((await readDirectoryUser('wes.west', ['userAccountControl']))?.userAccountControl) & 2,
    ).toBe(2);

    vi.restoreAllMocks();
    const after = await retry(job.id);

    expect(after.counts).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await readDirectoryUser('wes.west', ['userAccountControl']))?.userAccountControl).toBe(
      '512',
    );
    const events = await audits(job.id);
    expect(events.filter((e) => e.action === 'user.create').map((e) => e.result)).toEqual([
      'failure',
    ]);
    expect(events.find((e) => e.action === 'user.create.finish')).toMatchObject({
      result: 'success',
      metadata_json: expect.objectContaining({ adopted: true, steps: ['password', 'enable'] }),
    });
  });

  it('leaves the people a failed manager’s row manages partial, and the retry runs the manager first', async () => {
    let refuse = true;
    tamper((real) => ({
      createUser: async (input, ...rest) =>
        input.samAccountName === 'yul.yates' && refuse
          ? { ok: false, reason: 'permission_denied', errorMessage: 'refused', completed: [] }
          : real.createUser(input, ...rest),
    }));
    const job = await finishedJob(
      operator,
      (
        await run(
          request([row('xan.xu', { line: 2, managerRow: 1 }), row('yul.yates', { line: 3 })]),
        )
      ).id,
    );
    expect(job.counts).toMatchObject({ partial: 1, failed: 1 });
    const [xan, yul] = (await view(job.id)).rows;
    expect(yul).toMatchObject({ status: 'failed', errorMessage: /Not created/ });
    expect(xan).toMatchObject({
      status: 'partial',
      failed: [{ step: 'manager', message: 'Manager not set: Yul Yates (row 3) wasn’t created.' }],
    });

    refuse = false;
    const after = await retry(job.id);
    expect(after.counts).toMatchObject({ succeeded: 2 });
    const events = await audits(job.id);
    const yulCreated = events.findIndex(
      (e) =>
        e.action === 'user.create' &&
        e.result === 'success' &&
        e.metadata_json?.['samAccountName'] === 'yul.yates',
    );
    const managerSet = events.findIndex((e) => e.action === 'user.update');
    expect(yulCreated).toBeGreaterThan(-1);
    expect(managerSet).toBeGreaterThan(yulCreated);
    expect(String((await readDirectoryUser('xan.xu', ['manager']))?.manager)).toMatch(
      /^CN=Yul Yates,/,
    );
  });

  it('gives a row retried after the CSV was downloaded a random password, says so, and offers a reset', async () => {
    let refuse = true;
    tamper((real) => ({
      // The password is refused: the account is made, disabled, without one.
      createUser: async (input, _steps, finish, ctx) => {
        const r = await real.createUser(input, ['create'], finish, ctx);
        return refuse
          ? {
              ...r,
              ok: false,
              reason: 'policy_violation',
              errorMessage: 'refused',
              failedStep: 'password',
            }
          : r;
      },
    }));
    const job = await finishedJob(
      operator,
      (await run(request([row('zed.zane')], { password: { mode: 'generate', mustChange: false } })))
        .id,
    );
    expect(job.counts).toMatchObject({ partial: 1 });
    expect((await view(job.id)).rows[0]).toMatchObject({
      failed: [{ step: 'password', message: 'Password not set: refused' }],
      needsPasswordReset: false,
    });
    const csv = await operator.post(`/api/bulk-jobs/${job.id}/results`);
    expect(csv.statusCode, csv.body).toBe(200);
    // Its password was never set, so the CSV has none for it.
    expect(parseTable(csv.json<BulkJobResultsDownload>().csv).rows[0]![5]).toBe('');

    refuse = false;
    vi.restoreAllMocks();
    const after = await retry(job.id);
    expect(after.counts).toMatchObject({ succeeded: 1 });
    const viewed = await view(job.id);
    expect(viewed.results.passwords).toBe('downloaded');
    expect(viewed.rows[0]).toMatchObject({ status: 'succeeded', needsPasswordReset: true });
    expect((await audits(job.id, 'user.create.finish'))[0]).toMatchObject({
      metadata_json: expect.objectContaining({ passwordMode: 'random', passwordFallback: true }),
    });

    // The reset the page offers: the import's accounts, by the import.
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    await admin.stepUp();
    expect(
      (await admin.post('/api/users/bulk-reset-passwords', { importJobId: job.id })).statusCode,
    ).toBe(422);
    expect(
      (await operator.post('/api/users/bulk-reset-passwords', { ids: [viewed.rows[0]!.id] }))
        .statusCode,
    ).toBe(400);
    const started = await operator.post('/api/users/bulk-reset-passwords', {
      importJobId: job.id,
    });
    expect(started.statusCode, started.body).toBe(202);
    const reset = await finishedJob(operator, started.json<{ job: BulkJob }>().job.id);
    expect(reset).toMatchObject({
      action: 'user.password.reset',
      subject: { importJobId: job.id },
      revertible: false,
      counts: { succeeded: 1 },
    });
    expect((await view(job.id)).passwordReset).toMatchObject({
      job: { id: reset.id },
      results: { passwords: 'held' },
    });

    const res = await operator.post(`/api/bulk-jobs/${reset.id}/results`);
    expect(res.statusCode, res.body).toBe(200);
    const table = parseTable(res.json<BulkJobResultsDownload>().csv);
    expect(table.header).toEqual([
      'Status',
      'Display name',
      'Username',
      'UPN',
      'Password',
      'Must change password',
      'Problems',
    ]);
    const [status, , username, , password, mustChange] = table.rows[0]!;
    expect([status, username, mustChange]).toEqual(['Reset', 'zed.zane', 'Yes']);
    expect(password!.length).toBeGreaterThanOrEqual(16);
    expect((await readDirectoryUser('zed.zane', ['pwdLastSet']))?.pwdLastSet).toBe('0');
    expect((await operator.post(`/api/bulk-jobs/${reset.id}/results`)).statusCode).toBe(409);
    expect((await view(job.id)).passwordReset?.results.passwords).toBe('downloaded');
    const records = await api.app.db
      .selectFrom('bulk_job_rows')
      .select(['input_json', 'after_json', 'before_json'])
      .where('job_id', '=', reset.id)
      .execute();
    expect(JSON.stringify([records, await audits(reset.id)])).not.toContain(password);
    expect((await operator.get(`/api/bulk-jobs/${reset.id}/revert/preview`)).statusCode).toBe(422);
  });
});
