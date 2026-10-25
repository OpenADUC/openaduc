// SPDX-License-Identifier: BUSL-1.1
import type { AuditEventInput } from '../../src/services/audit.js';
import type { ImportJobResponse } from '@openaduc/shared';
import { describe, expect, it, vi } from 'vitest';
import { DOMAIN_ADMINS, row, useClassTaps } from './classTaps.js';
import { setGroupMember, type TestClient } from './harness.js';

// What keeps a class pass from the wrong hands: a holder who becomes an
// administrator loses it, a replaced pass is deleted in Entra, a pass
// that can't be stored isn't left live, the class acts only on the
// authority of someone who may still issue passes, a directory with the
// feature off holds none, and a pass the class didn't make isn't
// replaced unasked.

describe('class Temporary Access Pass safeguards', () => {
  const t = useClassTaps(['jo.jones', 'kai.kerr', 'lou.lane', 'max.moss']);
  let jobId: string;
  let admin: TestClient;

  /** Make `sam`'s pass now; returns their row on the roster. */
  async function issued(sam: string) {
    await t.sync(sam);
    await t.sweepDue();
    const r = await t.rosterRow(jobId, sam);
    expect(r).toMatchObject({ held: true });
    t.graph.requests = [];
    return r;
  }

  const asAdministrator = async (sam: string, run: () => Promise<void>) => {
    await setGroupMember(DOMAIN_ADMINS, sam, true);
    try {
      await run();
    } finally {
      await setGroupMember(DOMAIN_ADMINS, sam, false);
    }
  };

  it('sets up an import with a class', async () => {
    const job = await t.runImport([row('jo.jones', 2), row('kai.kerr', 3), row('lou.lane', 4)]);
    jobId = job.id;
    admin = t.api.client();
    await admin.signIn(t.api, 'oa.admin');
    await admin.stepUp();
  });

  it('takes a pass away at reveal from someone who has become an administrator', async () => {
    const jo = await issued('jo.jones');
    const { entra_method_id: method } = await t.passOf('jo.jones');
    await asAdministrator('jo.jones', async () => {
      const res = await t.reveal(t.operator, jobId, jo.rowId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: 'privileged', message: expect.stringContaining('member of Domain Admins') },
      });
    });
    expect(t.graph.deleted()).toEqual([{ entraUserId: 'entra-jo.jones', methodId: method }]);
    expect(await t.passOf('jo.jones')).toMatchObject({
      status: 'refused',
      pass_enc: null,
      error_code: 'privileged',
    });
    expect(await t.audits('import.classPass.revoke')).toEqual([
      expect.objectContaining({ error_code: 'privileged', target_id: jo.id }),
    ]);
    expect(await t.audits('import.classPass.reveal')).toEqual([
      expect.objectContaining({ result: 'failure', error_code: 'privileged' }),
    ]);
  });

  it('takes a pass away before class from someone who has become an administrator', async () => {
    const kai = await issued('kai.kerr');
    const { entra_method_id: method } = await t.passOf('kai.kerr');
    await asAdministrator('kai.kerr', async () => {
      await t.sweepDue(true);
    });
    expect(t.graph.deleted()).toEqual([{ entraUserId: 'entra-kai.kerr', methodId: method }]);
    expect(await t.rosterRow(jobId, 'kai.kerr')).toMatchObject({
      id: kai.id,
      status: 'refused',
      held: false,
      message: expect.stringContaining('member of Domain Admins'),
    });
  });

  it('refuses a reissue to an administrator, deleting the pass they hold', async () => {
    const lou = await issued('lou.lane');
    const { entra_method_id: method } = await t.passOf('lou.lane');
    await asAdministrator('lou.lane', async () => {
      const res = await t.reissue(t.operator, jobId, lou.rowId);
      expect(res.json()).toMatchObject({ outcome: 'refused' });
    });
    expect(t.graph.deleted()).toEqual([{ entraUserId: 'entra-lou.lane', methodId: method }]);
    expect(t.graph.created()).toEqual([]);
    expect(await t.passOf('lou.lane')).toMatchObject({ status: 'refused', pass_enc: null });
  });

  it('deletes a pass it made but couldn’t store, and makes it again later', async () => {
    const jo = await t.rosterRow(jobId, 'jo.jones');
    const audit = t.api.app.services.audit;
    const record = audit.recordEvent.bind(audit);
    const spy = vi
      .spyOn(audit, 'recordEvent')
      .mockImplementation(async (input: AuditEventInput, trx?: unknown) => {
        if (input.action === 'import.classPass.reissue' && input.result === 'success') {
          throw new Error('audit down');
        }
        return record(input, trx as never);
      });
    try {
      const res = await t.reissue(t.operator, jobId, jo.rowId);
      expect(res.json()).toMatchObject({
        outcome: 'failed',
        message: expect.stringContaining('deleted in Entra'),
      });
    } finally {
      spy.mockRestore();
    }
    const [made] = t.graph.created();
    expect(made?.entraUserId).toBe('entra-jo.jones');
    expect(t.graph.deleted().at(-1)).toEqual({
      entraUserId: 'entra-jo.jones',
      methodId: `tap-${t.graph.values.length}`,
    });
    expect(await t.passOf('jo.jones')).toMatchObject({
      status: 'waiting',
      pass_enc: null,
      error_code: 'store_failed',
    });

    await t.sweepDue();
    expect(await t.passOf('jo.jones')).toMatchObject({ status: 'issued' });
  });

  it('pauses the class when its authoriser can no longer issue passes, until someone takes over', async () => {
    await t.api.app.db
      .updateTable('import_classes')
      .set({
        authoriser_user_id: (await t.userId('oa.auditor')).id,
        authoriser_display_name: 'Ada Auditor',
      })
      .where('job_id', '=', jobId)
      .execute();
    await t.api.app.db
      .updateTable('class_passes')
      .set({ status: 'waiting', error_code: null, message: null })
      .where('row_id', '=', (await t.passOf('kai.kerr')).row_id)
      .execute();
    t.forgetReads();
    await t.sweepDue();
    expect(t.graph.created()).toEqual([]);
    const paused = await t.roster(jobId);
    expect(paused.alerts.authority).toEqual({
      name: 'Ada Auditor',
      message: expect.stringMatching(/^Ada Auditor can no longer issue passes .*take over/),
    });
    expect(paused.rows.find((r) => r.samAccountName === 'kai.kerr')?.status).toBe('paused');
    const page = (
      await t.operator.get(`/api/users/import/jobs/${jobId}`)
    ).json<ImportJobResponse>();
    expect(page.classTap?.alerts.authority?.name).toBe('Ada Auditor');
    expect(await t.audits('import.class.pause')).toHaveLength(1);

    const fresh = t.api.client();
    await fresh.signIn(t.api, 'oa.admin');
    expect((await fresh.post(t.rosterPath(jobId, '/take-over'))).json()).toMatchObject({
      error: { code: 'step_up_required' },
    });
    expect((await admin.post(t.rosterPath(jobId, '/take-over'))).statusCode).toBe(204);
    expect(await t.audits('import.class.takeOver')).toEqual([
      expect.objectContaining({
        actor_user_id: (await t.userId('oa.admin')).id,
        target_type: 'system',
        target_id: jobId,
      }),
    ]);
    await t.sweepDue();
    expect(t.graph.created().map((c) => c.entraUserId)).toEqual(['entra-kai.kerr']);
    expect((await t.audits('import.classPass.issue')).at(-1)).toMatchObject({
      actor_user_id: (await t.userId('oa.admin')).id,
      actor_auth_method: 'system',
    });
    expect((await t.roster(jobId)).alerts.authority).toBeNull();
  });

  it('holds no passes while the feature is off, retries nothing, and says why', async () => {
    const kai = await t.rosterRow(jobId, 'kai.kerr');
    await t.setFeature(false);
    try {
      await t.api.app.db
        .updateTable('class_passes')
        .set({ status: 'waiting' })
        .where('row_id', '=', (await t.passOf('lou.lane')).row_id)
        .execute();
      await t.sweepDue();
      const held = await t.api.app.db
        .selectFrom('class_passes')
        .select('row_id')
        .where('job_id', '=', jobId)
        .where('pass_enc', 'is not', null)
        .execute();
      expect(held).toEqual([]);
      expect(t.graph.requests).toEqual([]);

      const roster = await t.roster(jobId);
      expect(roster.alerts.off).toContain('turned off');
      expect(roster.rows.find((r) => r.samAccountName === 'lou.lane')?.status).toBe('paused');
      expect((await t.reveal(t.operator, jobId, kai.rowId)).json()).toMatchObject({
        error: { code: 'tap_not_enabled' },
      });
    } finally {
      await t.setFeature(true);
    }
  });

  it('doesn’t replace a pass the class didn’t make until someone reissues it', async () => {
    const job = await t.runImport([row('max.moss', 2)]);
    const entra = await t.sync('max.moss');
    t.graph.passes.set(entra, [
      {
        id: 'from-the-help-desk',
        createdDateTime: new Date().toISOString(),
        startDateTime: new Date().toISOString(),
        lifetimeInMinutes: 480,
        isUsableOnce: false,
      },
    ]);
    const madeForMax = () => t.graph.created().filter((c) => c.entraUserId === entra);
    await t.sweepDue();
    expect(madeForMax()).toEqual([]);
    const max = await t.rosterRow(job.id, 'max.moss');
    expect(max).toMatchObject({ status: 'otherPass', message: expect.stringContaining('Reissue') });

    expect((await t.reissue(t.operator, job.id, max.rowId)).json()).toMatchObject({
      outcome: 'issued',
    });
    expect(madeForMax()).toHaveLength(1);
  });
});
