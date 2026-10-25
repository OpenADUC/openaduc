// SPDX-License-Identifier: BUSL-1.1
import { computed, ref } from 'vue';
import {
  existingTapSchema,
  lifetimeLabel,
  tapRequestProblem,
  type ExistingTap,
  type TapIssueResponse,
  type TapPolicy,
  type TapPreflight,
  type UserDetail,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';

// Issue TAP on a user's page: read whether the user may have a Temporary
// Access Pass and within what limits, issue it after step-up, and hold its
// value only until the dialog is closed (`clear`).

export type TapTarget = Pick<UserDetail, 'id' | 'displayName' | 'samAccountName'>;

const LIFETIME_PRESETS = [10, 15, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 10080, 43200];

/** The lifetimes to offer within the tenant's policy, its own bounds and default among them. */
export function lifetimeOptionsFor(policy: TapPolicy): { value: number; label: string }[] {
  const values = new Set(
    [
      ...LIFETIME_PRESETS,
      policy.minLifetimeMinutes,
      policy.maxLifetimeMinutes,
      policy.defaultLifetimeMinutes,
    ].filter((v) => v >= policy.minLifetimeMinutes && v <= policy.maxLifetimeMinutes),
  );
  return [...values].sort((a, b) => a - b).map((value) => ({ value, label: lifetimeLabel(value) }));
}

export function useIssueTap(options: { onIssued?: (issued: TapIssueResponse) => void } = {}) {
  const auth = useAuthStore();
  const target = ref<TapTarget | null>(null);
  const preflight = ref<TapPreflight | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const startLater = ref(false);
  /** A `datetime-local` value, in the operator's time zone. */
  const startsAtLocal = ref('');
  const lifetimeMinutes = ref(60);
  const isUsableOnce = ref(true);
  const submitting = ref(false);
  const issued = ref<TapIssueResponse | null>(null);
  const copied = ref<boolean | null>(null);

  const policy = computed(() =>
    preflight.value?.status === 'ready' ? preflight.value.policy : null,
  );
  const existing = computed<ExistingTap | null>(() =>
    preflight.value?.status === 'ready' ? preflight.value.existing : null,
  );
  const multiUseAllowed = computed(() => policy.value?.usableOnceOnly === false);
  const lifetimeOptions = computed(() => (policy.value ? lifetimeOptionsFor(policy.value) : []));
  const startsAt = computed(() =>
    startLater.value && startsAtLocal.value ? new Date(startsAtLocal.value).toISOString() : null,
  );
  const problem = computed(() => {
    if (!policy.value) return null;
    if (startLater.value && !startsAtLocal.value) return 'Choose when the pass starts.';
    return tapRequestProblem(policy.value, {
      startsAt: startsAt.value,
      lifetimeMinutes: lifetimeMinutes.value,
      isUsableOnce: isUsableOnce.value,
    });
  });
  const canIssue = computed(() => !!policy.value && !problem.value && !issued.value);

  async function load(user: TapTarget): Promise<void> {
    target.value = user;
    preflight.value = null;
    error.value = null;
    startLater.value = false;
    startsAtLocal.value = '';
    clear();
    await reload();
  }

  async function reload(): Promise<void> {
    if (!target.value) return;
    loading.value = true;
    error.value = null;
    try {
      preflight.value = await api.users.tapPreflight(target.value.id);
      if (preflight.value.status === 'ready') {
        lifetimeMinutes.value = preflight.value.policy.defaultLifetimeMinutes;
        isUsableOnce.value = true;
      }
    } catch (err) {
      error.value = err instanceof ApiError ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function submit(): void {
    if (!target.value || !canIssue.value || submitting.value) return;
    auth.requireStepUp(commit);
  }

  async function commit(): Promise<void> {
    if (!target.value || !canIssue.value || submitting.value) return;
    submitting.value = true;
    error.value = null;
    try {
      issued.value = await api.users.issueTap(target.value.id, {
        startsAt: startsAt.value,
        lifetimeMinutes: lifetimeMinutes.value,
        isUsableOnce: isUsableOnce.value,
        // The dialog shows the pass the user holds before Issue is clicked.
        replaceExisting: existing.value !== null,
      });
      options.onIssued?.(issued.value);
    } catch (err) {
      if (auth.retryAfterStepUp(err, commit)) return;
      showHeldPass(err);
      error.value = err instanceof ApiError ? err.message : String(err);
    } finally {
      submitting.value = false;
    }
  }

  // Someone issued one since the dialog opened: show it, so the next
  // Issue replaces it knowingly.
  function showHeldPass(err: unknown): void {
    if (!(err instanceof ApiError) || err.code !== 'tap_exists') return;
    const held = existingTapSchema.safeParse((err.details as { existing?: unknown })?.existing);
    if (held.success && preflight.value?.status === 'ready') {
      preflight.value = { ...preflight.value, existing: held.data };
    }
  }

  async function copy(): Promise<void> {
    if (!issued.value) return;
    try {
      await navigator.clipboard.writeText(issued.value.temporaryAccessPass);
      copied.value = true;
    } catch {
      copied.value = false;
    }
  }

  /** Forget the pass; it can't be shown again. */
  function clear(): void {
    issued.value = null;
    copied.value = null;
  }

  return {
    target,
    preflight,
    loading,
    error,
    startLater,
    startsAtLocal,
    lifetimeMinutes,
    isUsableOnce,
    lifetimeOptions,
    multiUseAllowed,
    existing,
    problem,
    canIssue,
    submitting,
    issued,
    copied,
    load,
    reload,
    submit,
    copy,
    clear,
  };
}
