// SPDX-License-Identifier: BUSL-1.1
// State behind both reset-password dialogs (the modern one and the Old
// School "Reset Password" window).
//
// Checks the new password against the domain's policy as the operator
// types, and can generate one that passes. For a locked account, "also
// unlock" starts ticked and travels in the same request, so the API
// changes both in one directory modify.

import { computed, ref } from 'vue';
import type { DirectoryPolicy, UserDetail } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { checkPassword, generatePassword } from '../lib/passwordPolicy.js';

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
  const forceChangeAtNextLogin = ref(true);
  const alsoUnlock = ref(false);
  const submitting = ref(false);
  const error = ref<string | null>(null);

  const offerUnlock = computed(() => target.value?.locked === true);
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

  /** Start over for an account; give its id when the caller hasn't read it. */
  async function load(user: ResetTarget | string): Promise<void> {
    target.value = null;
    password.value = '';
    shown.value = false;
    forceChangeAtNextLogin.value = true;
    error.value = null;
    const policyLoaded = loadPolicy();
    loading.value = true;
    try {
      target.value = typeof user === 'string' ? (await api.users.get(user)).user : user;
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

  async function copy(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(password.value);
      return true;
    } catch {
      return false;
    }
  }

  async function submit(): Promise<void> {
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
      if (auth.retryAfterStepUp(err, submit)) return;
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
