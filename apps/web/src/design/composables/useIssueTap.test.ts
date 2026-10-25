// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TapPreflight } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const tapPreflight = vi.fn();
const issueTap = vi.fn();
const stepUp = vi.fn(async () => ({
  elevated: {
    active: true,
    idleExpiresAt: '2999-01-01T00:15:00.000Z',
    absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
  },
}));
vi.mock('../../api/index.js', () => ({
  api: { users: { tapPreflight, issueTap }, auth: { stepUp } },
}));

const { useIssueTap } = await import('./useIssueTap.js');
const { useAuthStore } = await import('../../stores/auth.js');

const policy = {
  defaultLifetimeMinutes: 60,
  minLifetimeMinutes: 30,
  maxLifetimeMinutes: 480,
  usableOnceOnly: false,
};
const ready: TapPreflight = { status: 'ready', policy, existing: null, inPolicyScope: true };
const existing = {
  createdAt: '2026-10-24T11:00:00Z',
  startsAt: '2026-10-24T11:00:00Z',
  lifetimeMinutes: 480,
  isUsableOnce: false,
  isUsable: true,
  usabilityReason: 'EnabledByPolicy',
};
const issued = {
  temporaryAccessPass: 'Tap-Value-7Kq2',
  startsAt: '2026-10-24T12:00:00.000Z',
  expiresAt: '2026-10-24T13:00:00.000Z',
  lifetimeMinutes: 60,
  isUsableOnce: true,
  replaced: false,
};
const alice = { id: 'u1', displayName: 'Alice Anders', samAccountName: 'alice.anders' };

async function setup(preflight: TapPreflight = ready, elevated = true) {
  setActivePinia(createPinia());
  useAuthStore().actor = {
    directoryId: 1,
    capabilities: ['read:user', 'write:user.issueTap'],
    elevated: { active: elevated },
  } as never;
  tapPreflight.mockResolvedValue(preflight);
  const onIssued = vi.fn();
  const tap = useIssueTap({ onIssued });
  await tap.load(alice);
  return { tap, onIssued };
}

const settled = () => new Promise((r) => setTimeout(r));

describe('useIssueTap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issueTap.mockResolvedValue(issued);
  });

  it('offers the lifetimes the tenant policy allows, starting at its default', async () => {
    const { tap } = await setup();
    const values = tap.lifetimeOptions.value.map((o) => o.value);
    expect(values[0]).toBe(30);
    expect(values.at(-1)).toBe(480);
    expect(values).toContain(60);
    expect(values.every((v) => v >= 30 && v <= 480)).toBe(true);
    expect(tap.lifetimeOptions.value.find((o) => o.value === 480)?.label).toBe('8 hours');
    expect(tap.lifetimeMinutes.value).toBe(60);
    expect(tap.isUsableOnce.value).toBe(true);
    expect(tap.multiUseAllowed.value).toBe(true);
  });

  it('allows only one-time passes when the tenant does', async () => {
    const { tap } = await setup({ ...ready, policy: { ...policy, usableOnceOnly: true } });
    expect(tap.multiUseAllowed.value).toBe(false);
    tap.isUsableOnce.value = false;
    expect(tap.problem.value).toBe('The tenant’s policy allows only one-time passes.');
    tap.submit();
    await settled();
    expect(issueTap).not.toHaveBeenCalled();
  });

  it('prompts step-up before issuing, then shows the pass once', async () => {
    const { tap, onIssued } = await setup(ready, false);
    tap.submit();
    await settled();
    expect(useAuthStore().stepUpRequested).toBe(true);
    expect(issueTap).not.toHaveBeenCalled();

    await useAuthStore().stepUp('pw');
    await vi.waitFor(() => expect(tap.issued.value).toEqual(issued));
    expect(issueTap).toHaveBeenCalledWith('u1', {
      startsAt: null,
      lifetimeMinutes: 60,
      isUsableOnce: true,
      replaceExisting: false,
    });
    expect(onIssued).toHaveBeenCalledOnce();

    tap.clear();
    expect(tap.issued.value).toBeNull();
  });

  it('starts the pass at the time chosen', async () => {
    const { tap } = await setup();
    tap.startLater.value = true;
    expect(tap.problem.value).toBe('Choose when the pass starts.');
    const tomorrow = new Date(Date.now() + 86_400_000);
    const local = `${tomorrow.toISOString().slice(0, 10)}T08:00`;
    tap.startsAtLocal.value = local;
    tap.submit();
    await settled();
    expect(issueTap).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ startsAt: new Date(local).toISOString() }),
    );

    tap.startsAtLocal.value = '2999-10-26T08:00';
    expect(tap.problem.value).toBe('The pass can start at most 30 days from now.');
  });

  it('warns that the pass the user holds will be replaced, and replaces it', async () => {
    const { tap } = await setup({ ...ready, existing });
    expect(tap.existing.value).toEqual(existing);
    tap.submit();
    await settled();
    expect(issueTap).toHaveBeenCalledWith('u1', expect.objectContaining({ replaceExisting: true }));
  });

  it('shows the warning when the server finds a pass the dialog didn’t, before replacing it', async () => {
    const { tap } = await setup();
    issueTap.mockRejectedValueOnce(
      new ApiError(409, 'tap_exists', 'This user already has a Temporary Access Pass.', {
        existing,
      }),
    );
    tap.submit();
    await settled();
    expect(tap.issued.value).toBeNull();
    expect(tap.existing.value).toEqual(existing);
    expect(tap.error.value).toBe('This user already has a Temporary Access Pass.');

    tap.submit();
    await settled();
    expect(issueTap).toHaveBeenLastCalledWith(
      'u1',
      expect.objectContaining({ replaceExisting: true }),
    );
    expect(tap.issued.value).toEqual(issued);
  });

  it('offers nothing to issue to a refused or unsynced user', async () => {
    for (const preflight of [
      { status: 'refused', reason: 'privileged', message: 'Alice is a member of Domain Admins.' },
      { status: 'unsynced', lastSyncAt: '2026-10-24T11:30:00.000Z' },
    ] as const) {
      const { tap } = await setup(preflight);
      expect(tap.canIssue.value).toBe(false);
      tap.submit();
      await settled();
      expect(issueTap).not.toHaveBeenCalled();
    }
  });

  it('says why it couldn’t read the user’s pass settings', async () => {
    setActivePinia(createPinia());
    tapPreflight.mockRejectedValueOnce(new ApiError(502, 'entra_error', 'Graph 403'));
    const tap = useIssueTap();
    await tap.load(alice);
    expect(tap.error.value).toBe('Graph 403');
    expect(tap.canIssue.value).toBe(false);
  });
});
