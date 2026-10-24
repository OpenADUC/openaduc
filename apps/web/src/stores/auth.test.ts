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
