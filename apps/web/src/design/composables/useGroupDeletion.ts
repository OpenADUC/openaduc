// SPDX-License-Identifier: BUSL-1.1
// The delete-group confirmation behind both UIs.
//
// Deleting a group can't be undone from here (and without the AD Recycle
// Bin, not at all), so it asks first: the preflight says how many members
// the group has and which groups it's in, or why it can't be deleted.
// `confirmed` stays false until the operator types the group's
// pre-Windows 2000 name. A failed delete stays in the dialog.

import { computed, ref } from 'vue';
import type { GroupDeletePreflightResponse } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { errorMessage } from '../lib/errorMessage.js';

/** Why the group can't be deleted, for the operator; null when it can. */
export function groupBlockText(p: GroupDeletePreflightResponse): string | null {
  switch (p.blockedReason) {
    case null:
      return null;
    case 'critical_system_object':
      return 'AD marks it as a critical system object.';
    case 'builtin_group':
      return 'It’s one of the built-in groups AD creates for itself.';
    case 'protected_group':
      return 'It’s a protected administrative group (adminCount=1).';
    case 'role_group':
      return `This group grants OpenADUC’s ${p.role ?? ''} role. Map the role to another group first.`;
    case 'member_of_protected_group': {
      const names = p.memberOf.filter((g) => g.protected).map((g) => g.name ?? g.distinguishedName);
      return `It’s a member of ${names.join(', ')}, a protected group. Take it out first.`;
    }
    case 'primary_group': {
      const n = p.primaryGroupMembers ?? 0;
      return `It’s the primary group of ${n} ${n === 1 ? 'account' : 'accounts'}. Give ${n === 1 ? 'it' : 'them'} another primary group first.`;
    }
  }
}

export function useGroupDeletion(options: { onDeleted: () => void | Promise<void> }) {
  const auth = useAuthStore();
  const phase = ref<'loading' | 'review' | 'error'>('loading');
  const loadError = ref<string | null>(null);
  const preflight = ref<GroupDeletePreflightResponse | null>(null);
  const typed = ref('');
  const deleting = ref(false);
  const error = ref<string | null>(null);

  const blockedText = computed(() => (preflight.value ? groupBlockText(preflight.value) : null));
  const confirmWord = computed(() => preflight.value?.samAccountName ?? '');
  const confirmed = computed(
    () =>
      phase.value === 'review' &&
      !blockedText.value &&
      !!confirmWord.value &&
      typed.value.trim().toLowerCase() === confirmWord.value.toLowerCase(),
  );

  async function load(id: string): Promise<void> {
    phase.value = 'loading';
    loadError.value = null;
    preflight.value = null;
    typed.value = '';
    error.value = null;
    try {
      preflight.value = await api.groups.deletePreflight(id);
      phase.value = 'review';
    } catch (err) {
      loadError.value = errorMessage(err, 'Couldn’t check the group');
      phase.value = 'error';
    }
  }

  function remove(): void {
    if (confirmed.value && !deleting.value) {
      auth.requireStepUp(commit, 'Deleting a group requires step-up authentication.');
    }
  }

  async function commit(): Promise<void> {
    const group = preflight.value;
    if (!group || !confirmed.value || deleting.value) return;
    deleting.value = true;
    error.value = null;
    try {
      await api.groups.remove(group.id, { confirmSamAccountName: confirmWord.value });
      await options.onDeleted();
    } catch (err) {
      if (auth.retryAfterStepUp(err, commit)) return;
      error.value = errorMessage(err, 'Delete failed');
    } finally {
      deleting.value = false;
    }
  }

  return {
    phase,
    loadError,
    preflight,
    typed,
    blockedText,
    confirmWord,
    confirmed,
    deleting,
    error,
    load,
    remove,
  };
}
