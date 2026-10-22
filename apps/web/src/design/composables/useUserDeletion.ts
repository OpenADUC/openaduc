// SPDX-License-Identifier: BUSL-1.1
// State behind both delete dialogs (the modern one and the Old School
// confirmation window).
//
// Starts with a server preflight: which of the accounts can be deleted, why
// the others can't, and whether the AD Recycle Bin will let them be
// restored. `confirmed` stays false until the operator types the account's
// logon name (one account) or DELETE (several). Deletes run one at a time
// so a failure on one account doesn't stop the rest.

import { computed, ref } from 'vue';
import type { UserDeleteBlockReason, UserDeletePreflightResponse } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';

export type PreflightUser = UserDeletePreflightResponse['users'][number];
export type DeletionPhase = 'loading' | 'review' | 'running' | 'finished' | 'error';

export const BLOCK_TEXT: Record<UserDeleteBlockReason, string> = {
  enabled: 'Still enabled. Disable it first.',
  critical_system_object: 'Critical system account',
  builtin_account: 'Built-in AD account',
  not_found: 'No longer in the directory',
};

export function useUserDeletion() {
  const phase = ref<DeletionPhase>('loading');
  const loadError = ref<string | null>(null);
  const preflight = ref<UserDeletePreflightResponse | null>(null);
  const typed = ref('');
  const progress = ref(0);
  const deletedIds = ref<string[]>([]);
  const failures = ref<{ user: PreflightUser; message: string }[]>([]);

  const eligible = computed(() => preflight.value?.users.filter((u) => !u.blockedReason) ?? []);
  const blocked = computed(() => preflight.value?.users.filter((u) => u.blockedReason) ?? []);
  const single = computed(() => (eligible.value.length === 1 ? eligible.value[0]! : null));

  // Accounts holding other objects (Exchange ActiveSync devices, …). AD can
  // only delete them together with those objects, which needs its own
  // explicit yes. An account whose objects couldn't be counted (null) may
  // hold some, so it asks for the same yes rather than failing the delete.
  const mayHoldObjects = (u: PreflightUser) => u.childObjects !== 0;
  const withChildren = computed(() => eligible.value.filter(mayHoldObjects));
  const childObjectTotal = computed(() =>
    withChildren.value.reduce((n, u) => n + (u.childObjects ?? 0), 0),
  );
  const childCountUnknown = computed(() => withChildren.value.some((u) => u.childObjects === null));
  const includeChildren = ref(false);

  // One account: its logon name, which proves the operator knows who
  // they're deleting. Several: a fixed word, since typing a list isn't
  // practical.
  const confirmWord = computed(() => single.value?.samAccountName ?? 'DELETE');
  const confirmed = computed(() => {
    const v = typed.value.trim();
    const typedOk = single.value
      ? v.toLowerCase() === confirmWord.value.toLowerCase()
      : v === 'DELETE';
    return typedOk && (withChildren.value.length === 0 || includeChildren.value);
  });

  async function load(ids: string[]): Promise<void> {
    phase.value = 'loading';
    loadError.value = null;
    preflight.value = null;
    typed.value = '';
    includeChildren.value = false;
    progress.value = 0;
    deletedIds.value = [];
    failures.value = [];
    try {
      preflight.value = await api.users.deletePreflight(ids);
      phase.value = 'review';
    } catch (err) {
      loadError.value = err instanceof ApiError ? err.message : String(err);
      phase.value = 'error';
    }
  }

  /** Delete every eligible account; resolves with the ids that are gone. */
  async function run(): Promise<string[]> {
    if (!confirmed.value || phase.value !== 'review') return [];
    phase.value = 'running';
    for (const u of eligible.value) {
      try {
        await api.users.remove(u.id, {
          confirmSamAccountName: u.samAccountName ?? '',
          ...(mayHoldObjects(u) ? { allowTreeDelete: includeChildren.value } : {}),
        });
        deletedIds.value.push(u.id);
      } catch (err) {
        failures.value.push({
          user: u,
          message: err instanceof ApiError ? err.message : String(err),
        });
      }
      progress.value += 1;
    }
    phase.value = 'finished';
    return [...deletedIds.value];
  }

  return {
    phase,
    loadError,
    preflight,
    typed,
    progress,
    deletedIds,
    failures,
    eligible,
    blocked,
    confirmWord,
    confirmed,
    withChildren,
    childObjectTotal,
    childCountUnknown,
    includeChildren,
    load,
    run,
  };
}

export function userLabel(u: PreflightUser): string {
  return u.displayName || u.samAccountName || u.id;
}
