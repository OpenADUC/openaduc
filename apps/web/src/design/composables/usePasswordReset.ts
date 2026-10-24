// SPDX-License-Identifier: BUSL-1.1
import { computed, ref, watch } from 'vue';
import type { DirectoryPolicy, UserDetail } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { checkPassword, generatePassword } from '@openaduc/shared';

export type ResetTarget = Pick<UserDetail, 'id' | 'samAccountName' | 'displayName' | 'locked'>;

export interface ResetOutcome {
  unlocked: boolean;
  forceChangeAtNextLogin: boolean;
}

const NO_ACCOUNT = { samAccountName: null, displayName: null };

export function usePasswordReset(options: { onReset: (outcome: ResetOutcome) => void }) {
  const auth = useAuthStore();
  const target = ref<ResetTarget | null>(null);
  const policy = ref<DirectoryPolicy | null>(null);
  const loading = ref(false);
  const password = ref('');
  const shown = ref(false);
  const copied = ref<boolean | null>(null);
  watch(password, () => (copied.value = null));
  const forceChangeAtNextLogin = ref(true);
  const alsoUnlock = ref(false);
  const submitting = ref(false);
  const error = ref<string | null>(null);

  const offerUnlock = computed(
    () => target.value?.locked === true && auth.hasCapability('write:user.unlock'),
  );
  const checks = computed(() =>
    checkPassword(password.value, policy.value, target.value ?? NO_ACCOUNT),
  );
  const acceptable = computed(() => checks.value.every((c) => c.met));
  const historyNote = computed(() => {
    const n = policy.value?.pwdHistoryLength;
    if (n === 0) return null;
    const which = n ? `its last ${n} passwords` : 'a recently used password';
    return `AD also refuses ${which}, which can’t be checked here.`;
  });

  // Reads the account even when the caller has it, so a lockout since the
  // caller's read is offered.
  async function load(id: string): Promise<void> {
    target.value = null;
    password.value = '';
    shown.value = false;
    copied.value = null;
    forceChangeAtNextLogin.value = true;
    error.value = null;
    const policyLoaded = loadPolicy();
    loading.value = true;
    try {
      target.value = (await api.users.get(id)).user;
      alsoUnlock.value = target.value.locked;
      await policyLoaded;
    } catch (err) {
      error.value = err instanceof ApiError ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  // Without the policy the check still applies the API's minimum and
  // assumes complexity.
  async function loadPolicy(): Promise<void> {
    policy.value = null;
    const directoryId = auth.actor?.directoryId;
    if (!directoryId) return;
    policy.value = await api.directories.policy(directoryId).then(
      (r) => r.policy,
      () => null,
    );
  }

  function generate(): void {
    password.value = generatePassword(policy.value, target.value ?? NO_ACCOUNT);
    shown.value = true;
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(password.value);
      copied.value = true;
    } catch {
      copied.value = false;
    }
  }

  function submit(): void {
    if (!target.value || !acceptable.value || submitting.value) return;
    auth.requireStepUp(commit);
  }

  async function commit(): Promise<void> {
    if (!target.value || !acceptable.value || submitting.value) return;
    submitting.value = true;
    error.value = null;
    const outcome: ResetOutcome = {
      unlocked: offerUnlock.value && alsoUnlock.value,
      forceChangeAtNextLogin: forceChangeAtNextLogin.value,
    };
    try {
      await api.users.resetPassword(target.value.id, {
        newPassword: password.value,
        forceChangeAtNextLogin: outcome.forceChangeAtNextLogin,
        unlock: outcome.unlocked,
      });
      options.onReset(outcome);
    } catch (err) {
      if (auth.retryAfterStepUp(err, commit)) return;
      error.value = err instanceof ApiError ? err.message : String(err);
    } finally {
      submitting.value = false;
    }
  }

  return {
    target,
    loading,
    password,
    shown,
    copied,
    forceChangeAtNextLogin,
    alsoUnlock,
    offerUnlock,
    checks,
    acceptable,
    historyNote,
    submitting,
    error,
    load,
    generate,
    copy,
    submit,
  };
}
