// SPDX-License-Identifier: BUSL-1.1
// Typed fetch client. Filled out alongside Phase 7 API endpoints.
import { BACKGROUND_REQUEST_HEADER, ELEVATED_IDLE_END_HEADER } from '@openaduc/shared';

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Hook called whenever the API responds 403 with code `step_up_required`.
 * Wired by the auth store at startup to open the global StepUpDialog
 * and clear stale local edit-mode state — so any privileged action that
 * fails because the cached step-up password is gone (process restart,
 * AD password rotation, TTL expiry that the client missed) re-prompts
 * automatically instead of forcing the operator to manually toggle
 * editing off and on.
 *
 * The originating ApiError is still thrown — the calling view can show
 * its action-specific toast — but the dialog opens in parallel so the
 * operator just has to type their password and click Restore again.
 */
let onStepUpRequired: ((message: string) => void) | null = null;
export function setStepUpRequiredHandler(fn: (message: string) => void): void {
  onStepUpRequired = fn;
}

/**
 * Hook called when a request comes back 401 `session_required`: the server
 * session has expired or been revoked. Wired in main.ts to clear the
 * signed-in state and send the operator to sign-in, then back. Other 401s
 * (a wrong password typed into a form, a missing service account) are left
 * to the caller.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/**
 * Hook called with the elevated session's idle end whenever a response
 * carries it. The server moves it on each request, so the auth store
 * listens here to keep its countdown in step.
 */
let onElevatedIdleEnd: ((iso: string) => void) | null = null;
export function setElevatedIdleEndHandler(fn: (iso: string) => void): void {
  onElevatedIdleEnd = fn;
}

export interface ApiFetchInit extends RequestInit {
  /**
   * The SPA is making this request by itself (polling), not because the
   * operator did something, so it doesn't keep an elevated session alive.
   */
  background?: boolean;
}

export async function apiFetch<T>(
  path: string,
  { background, ...init }: ApiFetchInit = {},
): Promise<T> {
  const url = path.startsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`;
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (background) headers.set(BACKGROUND_REQUEST_HEADER, '1');
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers,
  });
  const idleEnd = res.headers.get(ELEVATED_IDLE_END_HEADER);
  if (idleEnd) onElevatedIdleEnd?.(idleEnd);
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // ignore
    }
    const code = body.error?.code ?? 'unknown_error';
    const message = body.error?.message ?? res.statusText;
    if (res.status === 403 && code === 'step_up_required') {
      onStepUpRequired?.(message);
    }
    if (res.status === 401 && code === 'session_required') {
      onUnauthorized?.();
    }
    throw new ApiError(res.status, code, message, body.error?.details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
