// SPDX-License-Identifier: BUSL-1.1
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';
import type { LoginRequest, MeResponse } from '@openaduc/shared';
import { api } from '../api/index.js';
import { ApiError, setStepUpRequiredHandler } from '../api/client.js';

/**
 * Auth store. Owns:
 *   - the current actor (capabilities, identity, elevated state)
 *   - "edit mode" — a UI concept that mirrors the server's elevated session.
 *     When edit mode is on, the server has cached the user's bind password
 *     and writes commit without re-prompting. The store ticks `nowMs` once
 *     a second so views can derive a live countdown and auto-revert when
 *     the elevated session expires.
 */
export const useAuthStore = defineStore('auth', () => {
  const actor = ref<MeResponse | null>(null);
  const initialized = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  // Drives the global StepUpDialog mounted in AppShell. Set true by
  // `requestStepUp()`, which is called from the EditModeFab or
  // automatically when an API response says the cached step-up password
  // is gone (code: 'step_up_required'). The dialog watches this and
  // clears it via v-model when closed.
  const stepUpRequested = ref(false);
  // Optional message shown above the password field — used to explain
  // *why* the dialog opened when it was triggered automatically.
  const stepUpReason = ref<string | null>(null);
  // Optional retry callback queued by a caller whose action failed because
  // step-up was required. Runs after a successful step-up so the operator's
  // original click ("Save") completes without them having to re-do the
  // work. Cleared on cancel by AppShell's dialog visibility handler.
  const stepUpPendingAction = ref<(() => void | Promise<void>) | null>(null);

  // Reactive clock used to drive the edit-mode countdown. We store a single
  // number rather than re-creating Date instances so dependent computeds only
  // recompute once per tick.
  const nowMs = ref(Date.now());
  const tickHandle = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
  onScopeDispose(() => window.clearInterval(tickHandle));

  const isAuthenticated = computed(() => actor.value !== null);
  const elevatedExpiresAt = computed(() => actor.value?.elevated.expiresAt ?? null);
  const elevatedExpiresAtMs = computed(() => {
    const iso = elevatedExpiresAt.value;
    return iso ? new Date(iso).getTime() : null;
  });

  // Live derivation: we treat the actor as elevated only while the expiry is
  // still in the future. This way the toggle flips off automatically when
  // the server-side TTL lapses — no separate watcher needed.
  const elevated = computed(() => {
    if (actor.value?.elevated.active !== true) return false;
    const exp = elevatedExpiresAtMs.value;
    return exp === null || exp > nowMs.value;
  });

  const editMode = elevated;

  const remainingSeconds = computed(() => {
    if (!elevated.value || elevatedExpiresAtMs.value === null) return null;
    return Math.max(0, Math.floor((elevatedExpiresAtMs.value - nowMs.value) / 1000));
  });

  function hasCapability(cap: string): boolean {
    return actor.value?.capabilities.includes(cap) === true;
  }

  // Set of write capabilities the UI cares about. Used to decide whether
  // the Edit toggle is offered at all (vs. a read-only pill).
  const WRITE_CAPABILITIES = [
    'write:user.unlock',
    'write:user.resetPassword',
    'write:user.enableDisable',
    'write:user.attributes',
    'write:group.membership',
  ];
  const canEverWrite = computed(() =>
    WRITE_CAPABILITIES.some((c) => actor.value?.capabilities.includes(c) === true),
  );

  async function refresh(): Promise<void> {
    try {
      const resp = await api.auth.me();
      actor.value = resp.actor;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        actor.value = null;
      } else {
        // eslint-disable-next-line no-console
        console.error('me() failed', err);
      }
    } finally {
      initialized.value = true;
    }
  }

  async function login(body: LoginRequest): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const resp = await api.auth.login(body);
      actor.value = resp.actor;
    } catch (err) {
      actor.value = null;
      error.value = err instanceof ApiError ? err.message : 'Sign in failed';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } finally {
      actor.value = null;
    }
  }

  /**
   * Open the StepUpDialog. Called from:
   *   - The EditModeFab (no `reason` — user-initiated).
   *   - The API client when a response says the cached step-up password
   *     is missing/rejected (`reason` populated, e.g. "editing session
   *     expired"). In that case we also clear the local `actor.elevated`
   *     flag so the FAB visually drops to view-only rather than
   *     continuing to imply edit mode is armed.
   */
  function requestStepUp(reason: string | null = null): void {
    if (reason && actor.value?.elevated.active) {
      actor.value = {
        ...actor.value,
        elevated: { active: false, expiresAt: null },
      };
    }
    stepUpReason.value = reason;
    stepUpRequested.value = true;
  }

  // Wire the API client's auto-trigger. Calling this here (at store
  // setup) means the very first `useAuthStore()` registration takes
  // effect; subsequent calls overwrite with the same handler, which is
  // a harmless no-op.
  setStepUpRequiredHandler((message) => {
    requestStepUp(message);
  });

  async function stepUp(password: string): Promise<void> {
    const resp = await api.auth.stepUp({ password });
    if (actor.value) {
      actor.value = {
        ...actor.value,
        elevated: { active: resp.elevated.active, expiresAt: resp.elevated.expiresAt },
      };
    }
    // Run any retry queued by a caller whose original action triggered the
    // step-up. We fire-and-forget here so the dialog's confirm path stays
    // a normal "step-up succeeded" branch — the action surfaces its own
    // success/failure toast.
    const action = stepUpPendingAction.value;
    stepUpPendingAction.value = null;
    if (action) {
      void Promise.resolve()
        .then(action)
        .catch(() => {
          /* action handles its own error reporting */
        });
    }
  }

  /**
   * Run `action` if the operator is currently in edit mode; otherwise queue
   * the action as the step-up retry and open the StepUpDialog. Used by every
   * action button across the app whose work requires a writable session, so
   * an unauthenticated click always *does something* visible: either run
   * immediately, or pop the password dialog and auto-fire after auth. The
   * action is responsible for its own toast/error reporting.
   */
  function requireEdit(
    action: () => void | Promise<void>,
    reason: string | null = null,
  ): void {
    if (elevated.value) {
      void Promise.resolve()
        .then(action)
        .catch(() => {
          /* action handles its own error reporting */
        });
      return;
    }
    stepUpPendingAction.value = action;
    requestStepUp(reason);
  }

  async function revokeStepUp(): Promise<void> {
    try {
      await api.auth.revokeStepUp();
    } finally {
      if (actor.value) {
        actor.value = {
          ...actor.value,
          elevated: { active: false, expiresAt: null },
        };
      }
    }
  }

  // Aliases that read better at the call site for the edit-mode toggle.
  const enableEditMode = stepUp;
  const disableEditMode = revokeStepUp;

  return {
    actor,
    initialized,
    loading,
    error,
    isAuthenticated,
    elevated,
    elevatedExpiresAt,
    editMode,
    remainingSeconds,
    canEverWrite,
    hasCapability,
    refresh,
    login,
    logout,
    stepUp,
    revokeStepUp,
    enableEditMode,
    disableEditMode,
    stepUpRequested,
    stepUpReason,
    stepUpPendingAction,
    requestStepUp,
    requireEdit,
  };
});
