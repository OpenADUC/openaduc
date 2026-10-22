// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, setUnauthorizedHandler } from './client.js';

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('apiFetch on 401', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(() => {});
  });

  it('reports an expired session', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal('fetch', respond(401, { error: { code: 'session_required', message: 'x' } }));

    await expect(apiFetch('/users')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('leaves other 401s (wrong passwords, missing service account) to the caller', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal('fetch', respond(401, { error: { code: 'unauthorized', message: 'nope' } }));

    await expect(apiFetch('/auth/login', { method: 'POST', body: '{}' })).rejects.toThrow();
    await expect(apiFetch('/setup/service-account', { method: 'POST' })).rejects.toThrow();
    await expect(apiFetch('/users')).rejects.toThrow();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not treat step-up-required (403) as an expired session', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal('fetch', respond(403, { error: { code: 'step_up_required', message: 'x' } }));

    await expect(apiFetch('/users/1/unlock', { method: 'POST' })).rejects.toThrow();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
