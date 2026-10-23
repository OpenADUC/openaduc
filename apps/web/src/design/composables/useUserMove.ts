// SPDX-License-Identifier: BUSL-1.1
import { computed, ref } from 'vue';
import type { DirectoryOu, UserDetail } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { latestRequest } from '../lib/latestRequest.js';
import { useUndoableWrite, type UndoOffer, type WriteFailure } from '../lib/undoableWrite.js';

export type MoveSubject = Pick<
  UserDetail,
  'id' | 'samAccountName' | 'displayName' | 'distinguishedName'
>;

export interface MoveRun {
  user: MoveSubject;
  destinationDn: string;
  /** For an Undo: the OU the move put the user in, where they must still be. */
  whileIn?: string | undefined;
}

export type MoveFailure = WriteFailure<MoveRun>;

/**
 * Pick an OU and move a user there. `onMoved` gets the offer of Undo, which
 * moves the user back the same way, unless they came from somewhere that
 * isn't one of the OUs (a container such as CN=Users). An Undo first checks
 * the user is still where the move put them. `error` says why the account
 * or the OUs couldn't be read; a failed move stays in `failure` until it's
 * retried, dismissed or the next load.
 */
export function useUserMove(options: {
  onMoved: (user: MoveSubject, destinationDn: string, offer: UndoOffer) => void | Promise<void>;
  onFailed?: (failure: MoveFailure) => void | Promise<void>;
}) {
  const user = ref<MoveSubject | null>(null);
  const ous = ref<DirectoryOu[]>([]);
  const loading = ref(false);
  const destination = ref<string | null>(null);
  const error = ref<string | null>(null);
  const loads = latestRequest();

  const writes = useUndoableWrite<MoveRun>({
    write: async ({ user: u, destinationDn, whileIn }) => {
      if (whileIn) {
        const now = (await api.users.get(u.id)).user;
        if (!sameDn(parentOf(now.distinguishedName) ?? '', whileIn)) {
          throw new Error(
            `${u.displayName ?? u.samAccountName} has been moved again since, so it wasn’t moved back.`,
          );
        }
      }
      await api.users.move(u.id, { targetOuDn: destinationDn });
    },
    inverse: ({ user: u, destinationDn }) => {
      const from = parentOf(u.distinguishedName);
      const ou = from ? ous.value.find((o) => sameDn(o.distinguishedName, from)) : undefined;
      if (!ou) {
        return {
          cannotUndo: `It came from ${from ?? 'the domain root'}, which isn’t an OU, so it can’t be moved back from here.`,
        };
      }
      return { user: u, destinationDn: ou.distinguishedName, whileIn: destinationDn };
    },
    onDone: ({ user: u, destinationDn }, offer) => options.onMoved(u, destinationDn, offer),
    onFailed: options.onFailed,
  });
  const submitting = computed(() => writes.runningOn() !== null);

  const currentOuDn = computed(() => (user.value ? parentOf(user.value.distinguishedName) : null));
  const atCurrent = computed(
    () =>
      destination.value !== null &&
      currentOuDn.value !== null &&
      sameDn(destination.value, currentOuDn.value),
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
    writes.dismiss();
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
    writes.run({ user: user.value!, destinationDn: destination.value! });
  }

  /** The OU's name, for saying where a user went. */
  function ouName(dn: string): string {
    return ous.value.find((o) => sameDn(o.distinguishedName, dn))?.name ?? dn;
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
    failure: writes.failure,
    load,
    submit,
    ouName,
    retry: writes.retry,
    dismiss: writes.dismiss,
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

function sameDn(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
