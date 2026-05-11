// SPDX-License-Identifier: BUSL-1.1
// Typed fetch client. Filled out alongside Phase 7 API endpoints.

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

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`;
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers,
  });
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
    throw new ApiError(res.status, code, message, body.error?.details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
