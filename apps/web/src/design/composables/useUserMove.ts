// SPDX-License-Identifier: BUSL-1.1
import { computed, ref } from 'vue';
import type { DirectoryOu, UserDetail } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { latestRequest } from '../lib/latestRequest.js';

export type MoveSubject = Pick<
  UserDetail,
  'id' | 'samAccountName' | 'displayName' | 'distinguishedName'
>;

export interface MoveFailure {
  user: MoveSubject;
  destinationDn: string;
  message: string;
}

/**
 * Pick an OU and move a user there. `onMoved` gets `undo`, which moves the
 * user back to the OU they were in the same way; it's null for an undo.
 * `error` says why the account or the OUs couldn't be read; a failed move
 * stays in `failure` until it's retried, dismissed or the next load.
 */
export function useUserMove(options: {
  onMoved: (
    user: MoveSubject,
    destinationDn: string,
    undo: (() => void) | null,
  ) => void | Promise<void>;
  onFailed?: (user: MoveSubject, destinationDn: string, message: string) => void | Promise<void>;
}) {
  const auth = useAuthStore();
  const user = ref<MoveSubject | null>(null);
  const ous = ref<DirectoryOu[]>([]);
  const loading = ref(false);
  const destination = ref<string | null>(null);
  const submitting = ref(false);
  const error = ref<string | null>(null);
  const failure = ref<MoveFailure | null>(null);
  let retryFailed: (() => void) | null = null;
  const loads = latestRequest();

  const currentOuDn = computed(() => (user.value ? parentOf(user.value.distinguishedName) : null));
  const atCurrent = computed(
    () =>
      destination.value !== null &&
      currentOuDn.value !== null &&
      destination.value.toLowerCase() === currentOuDn.value.toLowerCase(),
  );
  const ready = computed(
    () => !!user.value && destination.value !== null && !atCurrent.value && !submitting.value,
  );

  // Reads the account even when the caller has it, so the current OU is
  // where it is now rather than where it was when the caller read it.
  async function load(id: string): Promise<void> {
    const isCurrent = loads.begin();
    user.value = null;
    ous.value = [];
    destination.value = null;
    error.value = null;
    dismiss();
    loading.value = true;
    try {
      const [u, list] = await Promise.all([api.users.get(id), api.ous.list()]);
      if (!isCurrent()) return;
      user.value = u.user;
      ous.value = list.ous;
      const current = currentOuDn.value?.toLowerCase();
      destination.value =
        list.ous.find((o) => o.distinguishedName.toLowerCase() === current)?.distinguishedName ??
        currentOuDn.value;
    } catch (err) {
      if (isCurrent()) error.value = err instanceof ApiError ? err.message : String(err);
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  function submit(): void {
    if (!ready.value) return;
    start(user.value!, destination.value!, false);
  }

  function start(u: MoveSubject, to: string, undoing: boolean): void {
    if (submitting.value) return;
    auth.requireStepUp(() => commit(u, to, undoing));
  }

  async function commit(u: MoveSubject, to: string, undoing: boolean): Promise<void> {
    if (submitting.value) return;
    submitting.value = true;
    dismiss();
    try {
      try {
        await api.users.move(u.id, { targetOuDn: to });
      } catch (err) {
        if (auth.retryAfterStepUp(err, () => commit(u, to, undoing))) return;
        const message = err instanceof ApiError ? err.message : String(err);
        failure.value = { user: u, destinationDn: to, message };
        retryFailed = () => start(u, to, undoing);
        await options.onFailed?.(u, to, message);
        return;
      }
      const from = parentOf(u.distinguishedName);
      const undo = undoing || !from ? null : () => start(u, from, true);
      await options.onMoved(u, to, undo);
    } finally {
      submitting.value = false;
    }
  }

  function retry(): void {
    retryFailed?.();
  }

  function dismiss(): void {
    failure.value = null;
    retryFailed = null;
  }

  return {
    user,
    ous,
    loading,
    currentOuDn,
    destination,
    atCurrent,
    ready,
    submitting,
    error,
    failure,
    load,
    submit,
    retry,
    dismiss,
  };
}

// Splits at the first unescaped comma, as the API does.
function parentOf(dn: string): string | null {
  for (let i = 0; i < dn.length; i++) {
    if (dn[i] === '\\') i++;
    else if (dn[i] === ',') return dn.slice(i + 1).trim() || null;
  }
  return null;
}
