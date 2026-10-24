// SPDX-License-Identifier: BUSL-1.1
// The bulk job runner against a real Postgres (its claims and run tokens
// are SQL), with a fake handler in place of the directory so each row's
// timing and outcome are the test's to decide.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bulkJobCreateRequestSchema, type BulkJobAction } from '@openaduc/shared';
import { DirectoryUnavailableError } from '../../src/providers/types.js';
import type {
  BulkJobHandler,
  BulkJobHandlers,
  BulkRowOutcome,
} from '../../src/services/bulkJobs/handlers.js';
import {
  BulkJobService,
  type BulkJobDeps,
  type JobActor,
} from '../../src/services/bulkJobs/service.js';
import { startApi, type TestApi } from './harness.js';

interface Call {
  targetId: string;
  release: (outcome?: BulkRowOutcome) => void;
  fail: (err: Error) => void;
}

describe('the bulk job runner', () => {
  let api: TestApi;
  let actor: JobActor;
  const services: BulkJobService[] = [];

  beforeAll(async () => {
    api = await startApi();
    const dir = await api.app.db
      .insertInto('directory_providers')
      .values({
        name: 'runner',
        type: 'active-directory',
        domain_name: 'runner.test',
        base_dn: 'DC=runner,DC=test',
        ldap_urls: ['ldaps://runner.test'],
        config_json: JSON.stringify({}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    actor = {
      directoryId: Number(dir.id),
      adminSessionId: randomUUID(),
      actorUserId: 'op',
      actorDisplayName: 'Operator',
      actorUsername: 'op',
      sourceIp: null,
      userAgent: null,
      correlationId: 'c1',
    };
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.stop()));
  });

  afterAll(async () => {
    await api?.close();
  });

  /** A runner whose rows wait in `calls` until the test releases them. */
  function runner(deps: Partial<BulkJobDeps> = {}) {
    const calls: Call[] = [];
    const handler: BulkJobHandler<z.infer<typeof bulkJobCreateRequestSchema>, null> = {
      action: 'user.disable',
      capability: 'write:user.enableDisable',
      request: bulkJobCreateRequestSchema,
      rows: ({ ids }) => ids.map((id) => ({ targetId: id, input: null })),
      input: z.null(),
      run: (row) =>
        new Promise((resolve, reject) => {
          calls.push({
            targetId: row.targetId,
            release: (
              outcome = { ok: true, before: { enabled: true }, after: { enabled: false } },
            ) => resolve(outcome),
            fail: reject,
          });
        }),
    };
    const service = new BulkJobService(
      api.app.db,
      {
        audit: api.app.services.audit,
        sessions: { findActiveElevated: async () => ({ id: 'e1' }) as never },
        credentialCache: { get: () => 'pw' },
        providers: { buildForDirectory: async () => ({ id: actor.directoryId }) as never },
        userLiveRefresh: { refresh: async () => null, reconcileDirectMemberships: async () => {} },
        ...deps,
      },
      api.app.log,
      { 'user.disable': handler } as BulkJobHandlers,
    );
    services.push(service);
    return { service, calls };
  }

  const ids = (n: number) => Array.from({ length: n }, () => randomUUID());

  const job = (id: string) =>
    api.app.db.selectFrom('bulk_jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  const rows = (id: string) =>
    api.app.db
      .selectFrom('bulk_job_rows')
      .select(['target_id', 'status', 'attempts', 'error_code'])
      .where('job_id', '=', id)
      .orderBy('ordinal')
      .execute();

  const start = (service: BulkJobService, n: number, action: BulkJobAction = 'user.disable') =>
    service.create(actor, action, { ids: ids(n) });

  const releaseAll = async (calls: Call[], count: number) => {
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(count));
    for (const c of calls.splice(0, count)) c.release();
  };

  it('runs every row once, a few at a time, then finishes', async () => {
    const { service, calls } = runner();
    const id = await start(service, 10);

    await vi.waitFor(() => expect(calls).toHaveLength(4));
    for (let done = 0; done < 10;) {
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
      done += calls.length;
      for (const c of calls.splice(0)) c.release();
    }

    await vi.waitFor(async () => expect((await job(id)).status).toBe('finished'));
    expect((await rows(id)).map((r) => [r.status, r.attempts])).toEqual(
      Array(10).fill(['succeeded', 1]),
    );
    expect((await job(id)).run_token).toBeNull();
  });

  it('lets the other rows finish when one worker fails, then pauses the job', async () => {
    let lookups = 0;
    const { service, calls } = runner({
      sessions: {
        findActiveElevated: async () => {
          if (++lookups === 5) throw new Error('database went away');
          return { id: 'e1' } as never;
        },
      },
    });
    const id = await start(service, 8);
    await vi.waitFor(() => expect(calls).toHaveLength(4));

    // Its worker's next lookup throws; the other three rows are still in flight.
    calls.shift()!.release();
    await vi.waitFor(() => expect(lookups).toBe(5));
    expect((await job(id)).status).toBe('running');

    for (const c of calls.splice(0)) c.release();

    await vi.waitFor(async () => expect((await job(id)).status).toBe('paused'));
    expect((await job(id)).pause_reason).toBe('interrupted');
    expect((await rows(id)).map((r) => r.status)).toEqual([
      ...Array(4).fill('succeeded'),
      ...Array(4).fill('pending'),
    ]);
  });

  it('pauses when no domain controller answers, the row it was on left to run again', async () => {
    const { service, calls } = runner();
    const id = await start(service, 6);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    const [first] = await rows(id);

    const failing = calls.findIndex((c) => c.targetId === first!.target_id);
    calls.splice(failing, 1)[0]!.fail(new DirectoryUnavailableError('dc1: ECONNREFUSED'));
    for (const c of calls.splice(0)) c.release();

    await vi.waitFor(async () => expect((await job(id)).status).toBe('paused'));
    expect((await job(id)).pause_reason).toBe('directory_unavailable');
    expect((await rows(id)).map((r) => r.status)).toEqual([
      'pending',
      'succeeded',
      'succeeded',
      'succeeded',
      'pending',
      'pending',
    ]);
    const pause = await api.app.db
      .selectFrom('audit_events')
      .select('metadata_json')
      .where('bulk_job_id', '=', id)
      .where('action', '=', 'bulk.pause')
      .executeTakeFirstOrThrow();
    expect(pause.metadata_json).toMatchObject({ reason: 'directory_unavailable' });
  });

  it('pauses before the first row without the operator’s password', async () => {
    const { service, calls } = runner({ credentialCache: { get: () => null } });
    const id = await start(service, 3);

    await vi.waitFor(async () => expect((await job(id)).status).toBe('paused'));
    expect((await job(id)).pause_reason).toBe('step_up_required');
    expect(calls).toHaveLength(0);
    expect((await rows(id)).every((r) => r.status === 'pending')).toBe(true);
  });

  it('a run that lost the job can’t record over, pause or finish the newer run', async () => {
    // Two processes: A's run goes quiet; B finds it stale and runs the job again.
    const a = runner();
    const b = runner();
    const id = await start(a.service, 3);
    await vi.waitFor(() => expect(a.calls).toHaveLength(3));
    const first = (await job(id)).run_token;

    await api.app.db
      .updateTable('bulk_jobs')
      .set({ heartbeat_at: new Date(Date.now() - 5 * 60_000) })
      .where('id', '=', id)
      .execute();
    await b.service.recoverStale();
    expect((await rows(id)).map((r) => r.error_code)).toEqual(Array(3).fill('interrupted'));
    expect(await b.service.retry((await job(id))!, actor)).toBe(true);
    await vi.waitFor(() => expect(b.calls).toHaveLength(3));
    const second = (await job(id)).run_token;
    expect(second).not.toBe(first);

    // A wakes up: its results, claims and finish all miss.
    await releaseAll(a.calls, 3);
    await a.service.stop();
    expect(await job(id)).toMatchObject({ status: 'running', run_token: second });
    expect((await rows(id)).map((r) => [r.status, r.attempts])).toEqual(
      Array(3).fill(['running', 2]),
    );

    await releaseAll(b.calls, 3);
    await vi.waitFor(async () => expect((await job(id)).status).toBe('finished'));
    expect((await rows(id)).map((r) => r.status)).toEqual(Array(3).fill('succeeded'));
  });
});
