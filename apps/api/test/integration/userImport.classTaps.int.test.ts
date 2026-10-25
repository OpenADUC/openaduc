// SPDX-License-Identifier: BUSL-1.1
import type { ClassReschedule, ImportCheckResponse, ImportJobResponse } from '@openaduc/shared';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { TAP_VALUE } from './fakeGraph.js';
import { DAY, DOMAIN_ADMINS, HOUR, atHour, day, row, useClassTaps } from './classTaps.js';
import { setGroupMember, type TestClient } from './harness.js';

// The class pass flow: options, the final check, waiting for sync, the
// roster and its alerts, reveal, reissue, reschedule, expiry and
// throttling. What keeps a pass from the wrong hands is in
// userImport.classTaps.security.int.test.ts.

describe('class Temporary Access Passes', () => {
  const t = useClassTaps([
    'cara.cole',
    'dev.dunn',
    'fay.ford',
    'gil.gray',
    'hana.holt',
    'ian.ives',
  ]);
  let jobId: string;
  let admin: TestClient;

  it('offers class passes within the tenant policy, while the feature is on', async () => {
    const res = await t.operator.get('/api/users/import/class-taps');
    expect(res.json()).toEqual({
      status: 'ready',
      policy: {
        defaultLifetimeMinutes: 60,
        minLifetimeMinutes: 60,
        maxLifetimeMinutes: 480,
        usableOnceOnly: false,
      },
    });
    await t.setFeature(false);
    try {
      expect((await t.operator.get('/api/users/import/class-taps')).json()).toMatchObject({
        status: 'unavailable',
      });
    } finally {
      await t.setFeature(true);
    }
  });

  it('holds the final check to the tenant policy and each row’s start date, if not 30 days', async () => {
    t.graph.policy.isUsableOnce = true;
    const check = await t.operator.post(
      '/api/users/import/check',
      t.request([row('cara.cole', 2)]).import,
    );
    expect(check.json<ImportCheckResponse>().problems).toEqual([
      { row: null, kind: 'class', message: 'The tenant’s policy allows only single-use passes.' },
    ]);

    t.graph.policy.isUsableOnce = false;
    t.api.app.services.graphClient.invalidateAll();
    const byStartDate = await t.operator.post(
      '/api/users/import/check',
      t.request(
        [
          row('cara.cole', 2, { startDate: day(3) }),
          row('dev.dunn', 3),
          row('fay.ford', 4, { startDate: day(40) }),
        ],
        { ...t.classTap(), start: { kind: 'startDate', time: '09:00', timeZone: 'UTC' } },
      ).import,
    );
    expect(byStartDate.json<ImportCheckResponse>().problems).toEqual([
      { row: 1, kind: 'class', message: expect.stringContaining('no start date') },
    ]);
  });

  it('waits for sync, then makes each pass to start with class, stored encrypted', async () => {
    const job = await t.runImport([row('cara.cole', 2), row('dev.dunn', 3)]);
    jobId = job.id;
    expect(job.subject?.import?.classTap).toEqual(t.classTap());

    await t.sweep();
    expect(t.graph.created()).toEqual([]);
    const waiting = await t.roster(jobId);
    expect(waiting).toMatchObject({
      job: { id: jobId, own: true },
      authoriser: { own: true },
      class: { start: { kind: 'fixed', startsAt: t.classStart }, lifetimeMinutes: 240 },
      lastSyncAt: '2026-10-24T11:30:00.000Z',
      alerts: { unsynced: null, stuck: [], authority: null, off: null },
    });
    expect(waiting.rows).toEqual([
      expect.objectContaining({
        line: 2,
        displayName: 'Cara Cole',
        samAccountName: 'cara.cole',
        personalEmail: 'cara@example.com',
        mobile: expect.stringContaining('7700'),
        status: 'waitingForSync',
        startsAt: t.classStart,
        held: false,
      }),
      expect.objectContaining({ samAccountName: 'dev.dunn', status: 'waitingForSync' }),
    ]);

    const cara = await t.sync('cara.cole');
    await t.sweepDue();
    expect(t.graph.created()).toEqual([
      {
        entraUserId: cara,
        body: { startDateTime: t.classStart, lifetimeInMinutes: 240, isUsableOnce: false },
      },
    ]);
    const stored = await t.passOf('cara.cole');
    expect(stored).toMatchObject({ status: 'issued', entra_user_id: cara });
    expect(stored.pass_enc).toMatch(/^v1\./);
    expect(stored.pass_enc).not.toContain(TAP_VALUE);

    t.forgetReads();
    const issued = await t.roster(jobId);
    expect(issued.rows.map((r) => [r.samAccountName, r.status, r.held])).toEqual([
      ['cara.cole', 'notYetValid', true],
      ['dev.dunn', 'waitingForSync', false],
    ]);
    // Read again within the minute: Graph isn't asked again.
    const reads = () =>
      t.graph.requests.filter((r) => r.method === 'GET' && r.url.includes('temporaryAccess'));
    const asked = reads().length;
    await t.roster(jobId);
    expect(reads().length).toBe(asked);

    const [event] = await t.audits('import.classPass.issue');
    expect(event).toMatchObject({
      result: 'success',
      actor_auth_method: 'system',
      actor_user_id: (await t.userId('oa.operator')).id,
      bulk_job_id: jobId,
      target_id: issued.rows[0]!.id,
    });
    expect(JSON.stringify(event)).not.toContain(TAP_VALUE);
  });

  it('lets any operator who may issue a TAP reveal a pass after step-up, auditing each', async () => {
    admin = t.api.client();
    await admin.signIn(t.api, 'oa.admin');
    const theirs = await t.roster(jobId, admin);
    expect(theirs.job.own).toBe(false);
    const cara = theirs.rows.find((r) => r.samAccountName === 'cara.cole')!;

    expect((await t.reveal(admin, jobId, cara.rowId)).json()).toMatchObject({
      error: { code: 'step_up_required' },
    });
    await admin.stepUp();
    const revealed = await t.reveal(admin, jobId, cara.rowId);
    expect(revealed.statusCode, revealed.body).toBe(200);
    expect(revealed.headers['cache-control']).toBe('no-store');
    expect(revealed.json()).toEqual({
      temporaryAccessPass: TAP_VALUE,
      startsAt: t.classStart,
      expiresAt: new Date(Date.parse(t.classStart) + 4 * HOUR).toISOString(),
      isUsableOnce: false,
    });

    const events = await t.audits('import.classPass.reveal');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'success', target_id: cara.id, bulk_job_id: jobId });
    expect(JSON.stringify(events)).not.toContain(TAP_VALUE);

    const auditor = t.api.client();
    await auditor.signIn(t.api, 'oa.auditor');
    expect((await auditor.get(t.rosterPath(jobId))).statusCode).toBe(403);
  });

  it('shows a pass Entra hasn’t listed as issued, and writes nothing to read the roster', async () => {
    const [made] = t.graph.passes.get('entra-cara.cole')!;
    const before = await t.passOf('cara.cole');
    t.graph.passes.set('entra-cara.cole', []);
    t.forgetReads();
    expect(await t.rosterRow(jobId, 'cara.cole')).toMatchObject({
      status: 'issued',
      message: 'Entra hasn’t listed it yet.',
      held: true,
    });

    t.graph.passes.set('entra-cara.cole', [{ ...made!, id: 'made-in-the-portal' }]);
    t.forgetReads();
    expect(await t.rosterRow(jobId, 'cara.cole')).toMatchObject({
      status: 'replaced',
      held: false,
    });
    expect(await t.passOf('cara.cole')).toEqual(before);
    // The sweep stops holding what the roster saw replaced.
    await t.sweep();
    expect(await t.passOf('cara.cole')).toMatchObject({ status: 'issued', pass_enc: null });
  });

  it('alerts on people still unsynced shortly before class, and on others apart', async () => {
    const dev = await t.passOf('dev.dunn');
    const soon = new Date(Date.now() + HOUR).toISOString();
    const set = (values: Record<string, unknown>) =>
      t.api.app.db
        .updateTable('class_passes')
        .set(values)
        .where('row_id', '=', dev.row_id)
        .execute();
    await set({ class_starts_at: soon });
    try {
      expect((await t.roster(jobId)).alerts.unsynced).toEqual({ count: 1, startsAt: soon });
      const page = (
        await t.operator.get(`/api/users/import/jobs/${jobId}`)
      ).json<ImportJobResponse>();
      expect(page.classTap?.alerts.unsynced).toEqual({ count: 1, startsAt: soon });

      await set({ error_code: 'entra_throttled', message: 'Microsoft Graph is busy.' });
      const { alerts } = await t.roster(jobId);
      expect(alerts.unsynced).toBeNull();
      expect(alerts.stuck).toEqual([{ message: 'Microsoft Graph is busy.', count: 1 }]);
    } finally {
      await set({ class_starts_at: t.classStart, error_code: 'unsynced', message: null });
    }
  });

  it('reissues a pass: the old one deleted in Entra first, the new one held, audited', async () => {
    await t.sync('cara.cole');
    const cara = await t.rosterRow(jobId, 'cara.cole');
    const res = await t.reissue(t.operator, jobId, cara.rowId);
    expect(res.json()).toEqual({ outcome: 'issued', message: null });
    const order = t.graph.requests
      .filter((r) => r.method !== 'GET' && r.url.includes('temporaryAccess'))
      .map((r) => r.method);
    expect(order).toEqual(['DELETE', 'POST']);
    const value = t.graph.values.at(-1);
    expect((await t.reveal(t.operator, jobId, cara.rowId)).json()).toMatchObject({
      temporaryAccessPass: value,
    });
    const [event] = await t.audits('import.classPass.reissue');
    expect(event).toMatchObject({
      result: 'success',
      actor_auth_method: 'ad-password',
      target_id: cara.id,
    });
  });

  it('reschedules class: old passes deleted in Entra, new ones made, by its new authoriser', async () => {
    const before = await t.passOf('cara.cole');
    const moved = atHour(Date.now() + 5 * DAY);
    const res = await admin.post(t.rosterPath(jobId, '/reschedule'), {
      start: { kind: 'fixed', startsAt: moved },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ClassReschedule>()).toEqual({ rescheduled: 2, skipped: [] });
    expect(await t.passOf('cara.cole')).toMatchObject({
      status: 'waiting',
      pass_enc: null,
      stale_method_id: before.entra_method_id,
      class_starts_at: new Date(moved),
    });
    const [event] = await t.audits('import.class.reschedule');
    expect(event).toMatchObject({
      result: 'success',
      target_type: 'system',
      target_id: jobId,
      actor_user_id: (await t.userId('oa.admin')).id,
      before_json: { start: { kind: 'fixed', startsAt: t.classStart } },
      after_json: { start: { kind: 'fixed', startsAt: moved } },
    });

    const cara = await t.sync('cara.cole');
    const dev = await t.sync('dev.dunn');
    await t.sweepDue();
    expect(t.graph.deleted()).toEqual([{ entraUserId: cara, methodId: before.entra_method_id }]);
    expect(t.graph.created().map((c) => [c.entraUserId, c.body['startDateTime']])).toEqual(
      expect.arrayContaining([
        [cara, moved],
        [dev, moved],
      ]),
    );
    t.forgetReads();
    const after = await t.roster(jobId);
    expect(after.class.start).toEqual({ kind: 'fixed', startsAt: moved });
    expect(after.authoriser).toEqual({ name: expect.any(String), own: false });
    expect(after.rows.map((r) => [r.status, r.held, r.startsAt])).toEqual([
      ['notYetValid', true, moved],
      ['notYetValid', true, moved],
    ]);
    const issued = (await t.audits('import.classPass.issue')).at(-1);
    expect(issued?.actor_user_id).toBe((await t.userId('oa.admin')).id);

    const past = await t.operator.post(t.rosterPath(jobId, '/reschedule'), {
      start: { kind: 'fixed', startsAt: new Date(Date.now() - HOUR).toISOString() },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({
      error: { message: 'The pass can’t start in the past.' },
    });
  });

  it('makes a pass 30 days ahead of class, and reschedules only whose class is still ahead', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const job = await t.runImport(
      [
        row('gil.gray', 2, { startDate: day(3) }),
        row('hana.holt', 3, { startDate: today }),
        row('ian.ives', 4, { startDate: day(40) }),
      ],
      { ...t.classTap(), start: { kind: 'startDate', time: '23:59', timeZone: 'UTC' } },
    );
    for (const sam of ['gil.gray', 'hana.holt', 'ian.ives']) await t.sync(sam);
    await t.sweepDue();
    expect(t.graph.created().map((c) => c.entraUserId)).toEqual(
      expect.arrayContaining(['entra-gil.gray', 'entra-hana.holt']),
    );
    expect(t.graph.created().map((c) => c.entraUserId)).not.toContain('entra-ian.ives');
    expect(await t.rosterRow(job.id, 'ian.ives')).toMatchObject({
      status: 'scheduled',
      held: false,
    });

    const res = await t.operator.post(t.rosterPath(job.id, '/reschedule'), {
      start: { kind: 'startDate', time: '00:00', timeZone: 'UTC' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ClassReschedule>()).toEqual({
      rescheduled: 2,
      skipped: [
        {
          rowId: expect.any(String),
          line: 3,
          displayName: 'Hana Holt',
          message: `Their start date is ${today}. The pass can’t start in the past.`,
        },
      ],
    });
    expect(await t.passOf('hana.holt')).toMatchObject({ status: 'issued' });
  });

  it('deletes a pass’s value once it expires', async () => {
    const dev = await t.passOf('dev.dunn');
    await t.api.app.db
      .updateTable('class_passes')
      .set({ expires_at: sql`now() - interval '1 minute'` })
      .where('row_id', '=', dev.row_id)
      .execute();
    await t.sweep();
    expect(await t.passOf('dev.dunn')).toMatchObject({ status: 'issued', pass_enc: null });
    const res = await t.reveal(t.operator, jobId, String(dev.row_id));
    expect(res.statusCode).toBe(410);
    expect(await t.rosterRow(jobId, 'dev.dunn')).toMatchObject({ status: 'expired', held: false });
    expect(await t.audits('import.classPass.reveal')).toEqual(
      expect.arrayContaining([expect.objectContaining({ result: 'failure', error_code: 'gone' })]),
    );
  });

  it('refuses a pass to an administrator, with the reason', async () => {
    const job = await t.runImport([row('fay.ford', 2)]);
    await setGroupMember(DOMAIN_ADMINS, 'fay.ford', true);
    await t.sync('fay.ford');
    await t.sweepDue();
    expect(t.graph.created()).toEqual([]);
    expect(await t.rosterRow(job.id, 'fay.ford')).toMatchObject({
      status: 'refused',
      held: false,
      message: expect.stringContaining('member of Domain Admins'),
    });
    expect(
      (await t.audits('import.classPass.issue')).filter((e) => e.bulk_job_id === job.id),
    ).toEqual([expect.objectContaining({ result: 'failure', error_code: 'privileged' })]);
  });

  it('waits out Graph throttling, holding back the directory’s passes as asked', async () => {
    const cara = await t.passOf('cara.cole');
    await t.api.app.db
      .updateTable('class_passes')
      .set({ status: 'waiting', pass_enc: null, entra_method_id: null })
      .where('row_id', '=', cara.row_id)
      .execute();
    t.graph.throttled = { path: /^\/users$/, retryAfter: 120 };
    try {
      await t.sweepDue();
      const throttled = await t.passOf('cara.cole');
      expect(throttled).toMatchObject({ status: 'waiting', error_code: 'entra_throttled' });
      expect(new Date(throttled.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 100_000);
      expect(await t.rosterRow(jobId, 'cara.cole')).toMatchObject({
        status: 'retrying',
        message: 'Microsoft Graph is busy.',
      });

      const asked = t.graph.requests.length;
      await t.sweepDue();
      expect(t.graph.requests.length).toBe(asked);
    } finally {
      t.graph.throttled = null;
    }
  });
});
