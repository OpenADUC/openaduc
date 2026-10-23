// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryOu, ElevatedSessionState } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';
import { aUserDetail } from '../../test/userDetail.js';

const ELEVATED: ElevatedSessionState = {
  active: true,
  idleExpiresAt: '2999-01-01T00:15:00.000Z',
  absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
};
const NOT_ELEVATED: ElevatedSessionState = {
  active: false,
  idleExpiresAt: null,
  absoluteExpiresAt: null,
};

const anOu = (distinguishedName: string, name: string, parentDn: string | null): DirectoryOu =>
  ({ distinguishedName, name, parentDn, stale: false }) as DirectoryOu;
const SALES = 'OU=Sales,DC=corp,DC=example';
const STAFF = 'OU=Staff,OU=Sales,DC=corp,DC=example';
const OUS = [anOu(SALES, 'Sales', null), anOu(STAFF, 'Staff', SALES)];

const get = vi.fn();
const list = vi.fn();
const move = vi.fn();
const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
vi.mock('../../api/index.js', () => ({
  api: { users: { get, move }, ous: { list }, auth: { stepUp } },
}));

const { useUserMove } = await import('./useUserMove.js');
const { useAuthStore } = await import('../../stores/auth.js');

async function setup(elevated = ELEVATED) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = { capabilities: [], elevated } as never;
  const onMoved = vi.fn();
  const mover = useUserMove({ onMoved });
  await mover.load('u1');
  return { mover, auth, onMoved };
}

describe('useUserMove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({
      user: aUserDetail({ distinguishedName: 'CN=Doe\\, Jane,ou=sales,DC=corp,DC=example' }),
    });
    list.mockResolvedValue({ ous: OUS });
    move.mockResolvedValue({ ok: true });
  });

  it('starts at the account’s current OU, and won’t move it there', async () => {
    const { mover } = await setup();
    expect(mover.ous.value).toEqual(OUS);
    expect(mover.currentOuDn.value).toBe('ou=sales,DC=corp,DC=example');
    expect(mover.destination.value).toBe(SALES);
    expect(mover.atCurrent.value).toBe(true);
    expect(mover.ready.value).toBe(false);

    mover.submit();
    expect(move).not.toHaveBeenCalled();
  });

  it('moves the account, then hands back where to', async () => {
    const { mover, onMoved } = await setup();
    mover.destination.value = STAFF;
    expect(mover.ready.value).toBe(true);

    mover.submit();
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledOnce());
    expect(move).toHaveBeenCalledWith('u1', { targetOuDn: STAFF });
    expect(onMoved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      STAFF,
      expect.any(Function),
    );
  });

  it('stays submitting until the refresh is done', async () => {
    let refreshed!: () => void;
    const { mover, onMoved } = await setup();
    onMoved.mockImplementation(() => new Promise<void>((r) => (refreshed = r)));
    mover.destination.value = STAFF;

    mover.submit();
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledOnce());
    expect(mover.submitting.value).toBe(true);
    refreshed();
    await vi.waitFor(() => expect(mover.submitting.value).toBe(false));
  });

  it('says why the move failed, and keeps the choice', async () => {
    const { mover, onMoved } = await setup();
    move.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'target OU not found'));
    mover.destination.value = STAFF;

    mover.submit();
    await vi.waitFor(() => expect(mover.failure.value?.message).toBe('target OU not found'));
    expect(mover.error.value).toBeNull();
    expect(onMoved).not.toHaveBeenCalled();
    expect(mover.submitting.value).toBe(false);
    expect(mover.destination.value).toBe(STAFF);
  });

  it('undoes a move by moving the account back to where it was', async () => {
    const { mover, onMoved } = await setup();
    mover.destination.value = STAFF;
    mover.submit();
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledOnce());
    // The dialog may be reopened for someone else before Undo is clicked.
    get.mockResolvedValueOnce({ user: aUserDetail({ id: 'u2' }) });
    await mover.load('u2');

    (onMoved.mock.calls[0]![2] as () => void)();
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledTimes(2));
    expect(move).toHaveBeenLastCalledWith('u1', { targetOuDn: 'ou=sales,DC=corp,DC=example' });
    expect(onMoved.mock.calls[1]![2]).toBeNull();
  });

  it('keeps a failed move until it’s retried', async () => {
    const { mover, onMoved } = await setup();
    move.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    mover.destination.value = STAFF;

    mover.submit();
    await vi.waitFor(() => expect(mover.failure.value).not.toBeNull());
    mover.retry();
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledOnce());
    expect(move).toHaveBeenCalledTimes(2);
    expect(mover.failure.value).toBeNull();
  });

  it('forgets a dismissed failure', async () => {
    const { mover } = await setup();
    move.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    mover.destination.value = STAFF;

    mover.submit();
    await vi.waitFor(() => expect(mover.failure.value).not.toBeNull());
    mover.dismiss();
    expect(mover.failure.value).toBeNull();
    mover.retry();
    expect(move).toHaveBeenCalledOnce();
  });

  it('says why the account or the OUs couldn’t be read', async () => {
    list.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'directory unreachable'));
    const { mover } = await setup();
    expect(mover.error.value).toBe('directory unreachable');
    expect(mover.loading.value).toBe(false);
    expect(mover.ready.value).toBe(false);
  });

  it('keeps the account it was opened for last, not a slower earlier one', async () => {
    const { mover } = await setup();
    let slow!: (v: unknown) => void;
    get.mockImplementationOnce(() => new Promise((r) => (slow = r)));
    get.mockResolvedValueOnce({ user: aUserDetail({ id: 'u2' }) });

    const first = mover.load('u1');
    await mover.load('u2');
    slow({ user: aUserDetail({ id: 'u1' }) });
    await first;
    expect(mover.user.value?.id).toBe('u2');
    expect(mover.loading.value).toBe(false);
  });

  it('prompts step-up first, then moves', async () => {
    const { mover, auth, onMoved } = await setup(NOT_ELEVATED);
    mover.destination.value = STAFF;

    mover.submit();
    expect(auth.stepUpRequested).toBe(true);
    expect(move).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledOnce());
  });

  it('moves after step-up when the server says the elevated session is gone', async () => {
    const { mover, auth, onMoved } = await setup();
    move.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));
    mover.destination.value = STAFF;

    mover.submit();
    await vi.waitFor(() => expect(move).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mover.submitting.value).toBe(false));
    expect(mover.failure.value).toBeNull();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledOnce());
    expect(move).toHaveBeenCalledTimes(2);
    expect(move).toHaveBeenLastCalledWith('u1', { targetOuDn: STAFF });
  });
});
