// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../api/client.js';
import { useAuthStore } from './auth.js';

const SOON = '2999-01-01T00:15:00.000Z';
const LATER = '2999-01-01T00:40:00.000Z';

function signedIn(elevated: boolean) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = {
    capabilities: [],
    elevated: elevated
      ? { active: true, idleExpiresAt: SOON, absoluteExpiresAt: '2999-01-01T04:00:00.000Z' }
      : { active: false, idleExpiresAt: null, absoluteExpiresAt: null },
  } as never; // only these fields matter
  return auth;
}

const respondWithIdleEnd = (iso: string) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'x-elevated-idle-expires-at': iso } }),
    ),
  );

describe('the elevated idle end', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows the server as activity moves it', async () => {
    const auth = signedIn(true);
    respondWithIdleEnd(LATER);

    await apiFetch('/users');
    expect(auth.elevatedIdleEndsAt).toBe(LATER);
  });

  it("doesn't bring back an elevated session the operator ended", async () => {
    const auth = signedIn(false);
    respondWithIdleEnd(LATER);

    await apiFetch('/users');
    expect(auth.elevated).toBe(false);
  });
});

describe('a write waiting on step-up', () => {
  it('tells its caller when the operator cancels the prompt', () => {
    const auth = signedIn(false);
    const action = vi.fn();
    const cancelled = vi.fn();

    auth.requireStepUp(action, null, cancelled);
    expect(auth.stepUpRequested).toBe(true);
    auth.cancelStepUp();

    expect(cancelled).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(auth.stepUpRequested).toBe(false);
    expect(auth.stepUpPendingAction).toBeNull();
  });

  it('forgets the cancel once the operator steps up', async () => {
    const auth = signedIn(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ elevated: { active: true } }))),
    );
    const action = vi.fn();
    const cancelled = vi.fn();

    auth.requireStepUp(action, null, cancelled);
    await auth.stepUp('pw');
    auth.cancelStepUp();
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(cancelled).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('a write the server refused for want of step-up', () => {
  afterEach(() => vi.unstubAllGlobals());

  const refuse = (details?: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'step_up_required', message: 'x', details } }),
            { status: 403 },
          ),
      ),
    );
  const write = () => apiFetch('/users/u1/unlock', { method: 'POST' });

  it('says writes were locked again when they looked unlocked', async () => {
    const auth = signedIn(true);
    refuse({ reason: 'not_elevated' });

    await expect(write()).rejects.toThrow();
    expect(auth.elevated).toBe(false);
    expect(auth.stepUpRequested).toBe(true);
    expect(auth.stepUpReason).toBe('Writes were locked again — confirm your password to continue.');
  });

  it('gives no reason when they already looked locked', async () => {
    const auth = signedIn(false);
    refuse({ reason: 'not_elevated' });

    await expect(write()).rejects.toThrow();
    expect(auth.stepUpRequested).toBe(true);
    expect(auth.stepUpReason).toBeNull();
  });

  it('says when the directory refused the password writes were unlocked with', async () => {
    const auth = signedIn(true);
    refuse({ reason: 'password_rejected' });

    await expect(write()).rejects.toThrow();
    expect(auth.stepUpReason).toBe(
      'The directory no longer accepts the password you unlocked writes with.',
    );
  });

  it('reads a refusal without a reason it knows as no elevated session', async () => {
    const auth = signedIn(true);
    refuse();

    await expect(write()).rejects.toThrow();
    expect(auth.stepUpReason).toBe('Writes were locked again — confirm your password to continue.');
  });
});
