// SPDX-License-Identifier: BUSL-1.1
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';
import type { ElevatedSessionState, LoginRequest, MeResponse } from '@openaduc/shared';
import { api } from '../api/index.js';
import { clearAllDrafts } from '../design/lib/importDraft.js';
import { ApiError, setElevatedIdleEndHandler, setStepUpRequiredHandler } from '../api/client.js';

const NOT_ELEVATED: ElevatedSessionState = {
  active: false,
  idleExpiresAt: null,
  absoluteExpiresAt: null,
};

/**
 * Auth store. Owns the current actor (capabilities, identity, elevated
 * state) and the step-up prompt. While the elevated session lives, the
 * server has cached the operator's bind password and writes commit without
 * re-prompting; a write without one prompts step-up and then runs. The
 * store ticks `nowMs` once a second so `elevated` turns false by itself
 * when the idle end passes.
 */
export const useAuthStore = defineStore('auth', () => {
  const actor = ref<MeResponse | null>(null);
  const initialized = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  // Drives the global StepUpDialog mounted in AppShell. Set true by
  // `requestStepUp()`, which is called by a write that needs step-up or
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
  // What the caller of the pending action wants done if the operator
  // cancels the step-up instead, so a queued write isn't dropped unseen.
  let stepUpCancelled: (() => void) | null = null;

  // Reactive clock that ends `elevated` at the idle end. We store a single
  // number rather than re-creating Date instances so dependent computeds only
  // recompute once per tick.
  const nowMs = ref(Date.now());
  const tickHandle = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
  onScopeDispose(() => window.clearInterval(tickHandle));

  const isAuthenticated = computed(() => actor.value !== null);
  // When the elevated session ends if the operator does nothing more. Kept
  // current by the idle end each response carries.
  const elevatedIdleEndsAt = computed(() => actor.value?.elevated.idleExpiresAt ?? null);
  const elevatedIdleEndsAtMs = computed(() => {
    const iso = elevatedIdleEndsAt.value;
    return iso ? new Date(iso).getTime() : null;
  });

  // Live derivation: we treat the actor as elevated only while the idle end
  // is still in the future, so it turns false when the server's elevated
  // session lapses — no separate watcher needed.
  const elevated = computed(() => {
    if (actor.value?.elevated.active !== true) return false;
    const exp = elevatedIdleEndsAtMs.value;
    return exp === null || exp > nowMs.value;
  });

  function hasCapability(cap: string): boolean {
    return actor.value?.capabilities.includes(cap) === true;
  }

  async function refresh(): Promise<void> {
    try {
      const resp = await api.auth.me();
      actor.value = resp.actor;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        actor.value = null;
      } else {
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

  /** The server no longer recognises the session (expired or revoked). */
  function sessionEnded(): void {
    actor.value = null;
  }

  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } finally {
      actor.value = null;
      clearAllDrafts();
    }
  }

  /** Open the StepUpDialog, saying why when the operator couldn't know. */
  function requestStepUp(reason: string | null = null): void {
    stepUpReason.value = reason;
    stepUpRequested.value = true;
  }

  // The server refused a write for want of step-up. Writes that looked
  // unlocked stop looking it, and the prompt says why it's back.
  // Registered at store setup; a later store registers the same handler.
  setStepUpRequiredHandler((refusal) => {
    const looked = actor.value?.elevated.active ?? false;
    if (actor.value && looked) actor.value = { ...actor.value, elevated: NOT_ELEVATED };
    if (refusal === 'password_rejected') {
      requestStepUp('The directory no longer accepts the password you unlocked writes with.');
    } else {
      requestStepUp(
        looked ? 'Writes were locked again — confirm your password to continue.' : null,
      );
    }
  });

  // Every request while elevated moves the idle end; responses carry it.
  setElevatedIdleEndHandler((idleExpiresAt) => {
    if (!actor.value?.elevated.active) return;
    actor.value = { ...actor.value, elevated: { ...actor.value.elevated, idleExpiresAt } };
  });

  async function stepUp(password: string): Promise<void> {
    const resp = await api.auth.stepUp({ password });
    if (actor.value) {
      actor.value = {
        ...actor.value,
        elevated: resp.elevated,
      };
    }
    // Run any retry queued by a caller whose original action triggered the
    // step-up. We fire-and-forget here so the dialog's confirm path stays
    // a normal "step-up succeeded" branch — the action surfaces its own
    // success/failure toast.
    const action = stepUpPendingAction.value;
    stepUpPendingAction.value = null;
    stepUpCancelled = null;
    if (action) {
      void Promise.resolve()
        .then(action)
        .catch(() => {
          /* action handles its own error reporting */
        });
    }
  }

  /**
   * Run `action` if the operator has an elevated session; otherwise queue
   * the action as the step-up retry and open the StepUpDialog. Used by every
   * write across the app, so a click without one always *does something*
   * visible: either run immediately, or pop the password dialog and run
   * after step-up. The action is responsible for its own toast/error
   * reporting.
   */
  function requireStepUp(
    action: () => void | Promise<void>,
    reason: string | null = null,
    onCancel?: () => void,
  ): void {
    if (elevated.value) {
      void Promise.resolve()
        .then(action)
        .catch(() => {
          /* action handles its own error reporting */
        });
      return;
    }
    queue(action, onCancel);
    requestStepUp(reason);
  }

  function queue(action: () => void | Promise<void>, onCancel?: () => void): void {
    stepUpPendingAction.value = action;
    stepUpCancelled = onCancel ?? null;
  }

  /** The operator closed the step-up prompt without stepping up. */
  function cancelStepUp(): void {
    stepUpRequested.value = false;
    stepUpReason.value = null;
    stepUpPendingAction.value = null;
    const cancelled = stepUpCancelled;
    stepUpCancelled = null;
    cancelled?.();
  }

  /**
   * For a write's catch block: when `err` says step-up is required (the API
   * client has already opened the dialog), queue `retry` to run once the
   * operator steps up and return true. Otherwise return false so the caller
   * reports the error.
   */
  function retryAfterStepUp(
    err: unknown,
    retry: () => void | Promise<void>,
    onCancel?: () => void,
  ): boolean {
    if (!(err instanceof ApiError) || err.code !== 'step_up_required') return false;
    queue(retry, onCancel);
    return true;
  }

  async function revokeStepUp(): Promise<void> {
    try {
      await api.auth.revokeStepUp();
    } finally {
      if (actor.value) {
        actor.value = {
          ...actor.value,
          elevated: NOT_ELEVATED,
        };
      }
    }
  }

  return {
    sessionEnded,
    actor,
    initialized,
    loading,
    error,
    isAuthenticated,
    elevated,
    elevatedIdleEndsAt,
    hasCapability,
    refresh,
    login,
    logout,
    stepUp,
    revokeStepUp,
    stepUpRequested,
    stepUpReason,
    stepUpPendingAction,
    requestStepUp,
    requireStepUp,
    retryAfterStepUp,
    cancelStepUp,
  };
});
