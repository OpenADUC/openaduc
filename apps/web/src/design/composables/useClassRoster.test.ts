// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassRoster, ClassRosterRow } from '@openaduc/shared';

const classRoster = vi.fn();
const revealClassPass = vi.fn();
const reissueClassPass = vi.fn();
const rescheduleClass = vi.fn();
const stepUp = vi.fn(async () => ({
  elevated: {
    active: true,
    idleExpiresAt: '2999-01-01T00:15:00.000Z',
    absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
  },
}));
vi.mock('../../api/index.js', () => ({
  api: {
    users: { import: { classRoster, revealClassPass, reissueClassPass, rescheduleClass } },
    auth: { stepUp },
  },
}));

const { useClassRoster } = await import('./useClassRoster.js');
const { useAuthStore } = await import('../../stores/auth.js');
const { ApiError } = await import('../../api/client.js');

const ROW: ClassRosterRow = {
  rowId: '7',
  line: 2,
  displayName: 'Cara Cole',
  samAccountName: 'cara.cole',
  personalEmail: 'cara@example.com',
  mobile: '+44 7700 900123',
  id: 'u-cara',
  status: 'notYetValid',
  message: null,
  startsAt: '2026-10-28T09:00:00.000Z',
  expiresAt: '2026-10-28T13:00:00.000Z',
  held: true,
};
const ROSTER: ClassRoster = {
  job: {
    id: '42',
    actorDisplayName: 'Olive Operator',
    createdAt: '2026-10-24T08:00:00Z',
    own: true,
  },
  class: {
    start: { kind: 'fixed', startsAt: '2026-10-28T09:00:00.000Z' },
    lifetimeMinutes: 240,
    isUsableOnce: false,
    updatedAt: '2026-10-24T08:00:00Z',
  },
  lastSyncAt: '2026-10-24T11:30:00.000Z',
  unsyncedAlert: null,
  statusError: null,
  rows: [ROW],
};
const PASS = {
  temporaryAccessPass: 'Tap-Value-7Kq2',
  startsAt: ROW.startsAt!,
  expiresAt: ROW.expiresAt!,
  isUsableOnce: false,
};

const settled = () => new Promise((r) => setTimeout(r));

async function setup(elevated = true) {
  setActivePinia(createPinia());
  useAuthStore().actor = {
    directoryId: 1,
    capabilities: ['read:user', 'write:user.issueTap'],
    elevated: { active: elevated },
  } as never;
  const writeClipboard = vi.fn(async () => undefined);
  const scope = effectScope();
  const roster = scope.run(() => useClassRoster({ writeClipboard }))!;
  await roster.open('42');
  return { roster, writeClipboard, stop: () => scope.stop() };
}

describe('useClassRoster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classRoster.mockResolvedValue(ROSTER);
    revealClassPass.mockResolvedValue(PASS);
    reissueClassPass.mockResolvedValue({ outcome: 'issued', message: null });
    rescheduleClass.mockResolvedValue(undefined);
  });

  it('loads the import’s roster', async () => {
    const { roster, stop } = await setup();
    expect(classRoster).toHaveBeenCalledWith('42', { background: false });
    expect(roster.rows.value).toEqual([ROW]);
    stop();
  });

  it('reveals a pass after step-up, and holds it only until it’s hidden', async () => {
    const { roster, stop } = await setup(false);
    roster.reveal('7');
    await settled();
    expect(revealClassPass).not.toHaveBeenCalled();
    expect(useAuthStore().stepUpRequested).toBe(true);

    await useAuthStore().stepUp('pw');
    await settled();
    expect(revealClassPass).toHaveBeenCalledWith('42', '7');
    expect(roster.revealed.value['7']).toEqual(PASS);

    roster.hide('7');
    expect(roster.revealed.value['7']).toBeUndefined();
    stop();
  });

  it('copies a pass, revealing it first when it isn’t shown', async () => {
    const { roster, writeClipboard, stop } = await setup();
    roster.copy('7');
    await settled();
    expect(writeClipboard).toHaveBeenCalledWith('Tap-Value-7Kq2');
    roster.copy('7');
    await settled();
    expect(revealClassPass).toHaveBeenCalledTimes(1);
    expect(roster.rowNotes.value['7']).toEqual({ tone: 'ok', text: 'Copied.' });
    stop();
  });

  it('reissues a pass once confirmed, forgetting the one shown', async () => {
    const { roster, stop } = await setup();
    roster.reveal('7');
    await settled();
    roster.requestReissue('7');
    expect(roster.confirmingReissue.value).toBe('7');
    roster.reissue();
    await settled();
    expect(reissueClassPass).toHaveBeenCalledWith('42', '7');
    expect(roster.revealed.value['7']).toBeUndefined();
    expect(classRoster).toHaveBeenCalledTimes(2);
    expect(roster.rowNotes.value['7']?.tone).toBe('ok');
    stop();
  });

  it('says why a reissue didn’t take', async () => {
    reissueClassPass.mockResolvedValue({
      outcome: 'failed',
      message:
        'Their pass wasn’t replaced, so the one they have still stands: Microsoft Entra refused.',
    });
    const { roster, stop } = await setup();
    roster.requestReissue('7');
    roster.reissue();
    await settled();
    expect(roster.rowNotes.value['7']).toEqual({
      tone: 'error',
      text: expect.stringContaining('still stands'),
    });
    stop();
  });

  it('retries a reveal after a step-up the session lost meanwhile', async () => {
    revealClassPass.mockRejectedValueOnce(
      new ApiError(403, 'step_up_required', 'Step-up required', { reason: 'not_elevated' }),
    );
    const { roster, stop } = await setup();
    roster.reveal('7');
    await settled();
    expect(roster.revealed.value['7']).toBeUndefined();
    await useAuthStore().stepUp('pw');
    await settled();
    expect(revealClassPass).toHaveBeenCalledTimes(2);
    expect(roster.revealed.value['7']).toEqual(PASS);
    stop();
  });

  it('reschedules class from the start it has, then shows the roster afresh', async () => {
    const { roster, stop } = await setup();
    roster.startReschedule();
    expect(roster.rescheduling.value).toBe(true);
    expect(new Date(`${roster.newDate.value}T${roster.newTime.value}`).toISOString()).toBe(
      '2026-10-28T09:00:00.000Z',
    );
    roster.newDate.value = '2026-10-30';
    roster.reschedule();
    await settled();
    expect(rescheduleClass).toHaveBeenCalledWith('42', {
      start: {
        kind: 'fixed',
        startsAt: new Date('2026-10-30T' + roster.newTime.value).toISOString(),
      },
    });
    expect(roster.rescheduling.value).toBe(false);
    expect(classRoster).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps a class on each person’s start date when rescheduled, moving its time', async () => {
    classRoster.mockResolvedValue({
      ...ROSTER,
      class: { ...ROSTER.class, start: { kind: 'startDate', time: '09:00', timeZone: 'UTC' } },
    });
    const { roster, stop } = await setup();
    roster.startReschedule();
    roster.newTime.value = '10:30';
    roster.reschedule();
    await settled();
    expect(rescheduleClass).toHaveBeenCalledWith('42', {
      start: { kind: 'startDate', time: '10:30', timeZone: 'UTC' },
    });
    stop();
  });
});
