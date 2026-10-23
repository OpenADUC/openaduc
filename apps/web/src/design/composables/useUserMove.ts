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

export function useUserMove(options: {
  onMoved: (user: MoveSubject, destinationDn: string) => void | Promise<void>;
}) {
  const auth = useAuthStore();
  const user = ref<MoveSubject | null>(null);
  const ous = ref<DirectoryOu[]>([]);
  const loading = ref(false);
  const destination = ref<string | null>(null);
  const submitting = ref(false);
  const error = ref<string | null>(null);
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
    auth.requireStepUp(() => commit(destination.value!));
  }

  async function commit(to: string): Promise<void> {
    const u = user.value;
    if (!u || submitting.value) return;
    submitting.value = true;
    error.value = null;
    try {
      try {
        await api.users.move(u.id, { targetOuDn: to });
      } catch (err) {
        if (auth.retryAfterStepUp(err, () => commit(to))) return;
        error.value = err instanceof ApiError ? err.message : String(err);
        return;
      }
      await options.onMoved(u, to);
    } finally {
      submitting.value = false;
    }
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
    load,
    submit,
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
