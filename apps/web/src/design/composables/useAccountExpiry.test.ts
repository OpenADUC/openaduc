// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElevatedSessionState } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const ELEVATED: ElevatedSessionState = {
  active: true,
  idleExpiresAt: '2999-01-01T00:15:00.000Z',
  absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
};

const setAccountExpiry = vi.fn();
vi.mock('../../api/index.js', () => ({
  api: { users: { setAccountExpiry } },
}));

const { useAccountExpiry } = await import('./useAccountExpiry.js');
const { useAuthStore } = await import('../../stores/auth.js');

// Local calendar days: the expiry is the midnight that ends the day, as ADUC
// writes it, in the operator's time zone.
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const PAST = day(2020, 1, 1).toISOString();
const END_OF_MAR_1 = day(2031, 3, 2).toISOString();
const bob = (accountExpiresAt: string | null) => ({
  id: 'u2',
  name: 'Bob Baker',
  accountExpiresAt,
});

function setup() {
  setActivePinia(createPinia());
  useAuthStore().actor = { capabilities: [], elevated: ELEVATED } as never;
  const onSet = vi.fn();
  const expiry = useAccountExpiry({ onSet });
  return { expiry, onSet };
}

describe('useAccountExpiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAccountExpiry.mockResolvedValue({ ok: true });
  });

  it('asks for a day when the account has expired', () => {
    const { expiry } = setup();
    expiry.load(bob(PAST));
    expect(expiry.never.value).toBe(false);
    expect(expiry.endOf.value).toBeNull();
    expect(expiry.ready.value).toBe(false);
  });

  it('starts from the current expiry, and is ready once it changes', () => {
    const { expiry } = setup();
    expiry.load(bob(END_OF_MAR_1));
    expect(expiry.endOf.value).toEqual(day(2031, 3, 1));
    expect(expiry.ready.value).toBe(false);

    expiry.endOf.value = day(2031, 6, 30);
    expect(expiry.ready.value).toBe(true);

    expiry.load(bob(null));
    expect(expiry.never.value).toBe(true);
    expect(expiry.ready.value).toBe(false);
  });

  it('won’t set a day that has already ended', () => {
    const { expiry } = setup();
    expiry.load(bob(PAST));
    expiry.endOf.value = day(2021, 1, 1);
    expect(expiry.ready.value).toBe(false);
  });

  it('extends the account to the end of the day picked, and undoes it', async () => {
    const { expiry, onSet } = setup();
    expiry.load(bob(PAST));
    expiry.endOf.value = day(2031, 3, 1);

    expiry.submit();
    await vi.waitFor(() => expect(onSet).toHaveBeenCalledOnce());
    expect(setAccountExpiry).toHaveBeenCalledWith('u2', { expiresAt: END_OF_MAR_1 });
    expect(onSet.mock.calls[0]!.slice(0, 2)).toEqual([bob(PAST), END_OF_MAR_1]);

    (onSet.mock.calls[0]![2] as { undo: () => void }).undo();
    await vi.waitFor(() => expect(setAccountExpiry).toHaveBeenCalledTimes(2));
    expect(setAccountExpiry).toHaveBeenLastCalledWith('u2', { expiresAt: PAST });
  });

  it('clears the expiry so the account never expires', async () => {
    const { expiry, onSet } = setup();
    expiry.load(bob(PAST));
    expiry.never.value = true;

    expiry.submit();
    await vi.waitFor(() => expect(onSet).toHaveBeenCalledOnce());
    expect(setAccountExpiry).toHaveBeenCalledWith('u2', { expiresAt: null });
  });

  it('keeps a failure until it’s retried', async () => {
    const { expiry, onSet } = setup();
    setAccountExpiry.mockRejectedValueOnce(new ApiError(502, 'bad_gateway', 'directory down'));
    expiry.load(bob(PAST));
    expiry.never.value = true;

    expiry.submit();
    await vi.waitFor(() => expect(expiry.failure.value?.message).toBe('directory down'));
    expect(onSet).not.toHaveBeenCalled();

    expiry.retry();
    await vi.waitFor(() => expect(onSet).toHaveBeenCalledOnce());
    expect(expiry.failure.value).toBeNull();
  });
});
