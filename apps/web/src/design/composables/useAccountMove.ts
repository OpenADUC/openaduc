// SPDX-License-Identifier: BUSL-1.1
import { computed, ref } from 'vue';
import type { DirectoryOu, MoveRequest } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { computerName } from '../lib/format.js';
import { latestRequest } from '../lib/latestRequest.js';
import { useUndoableWrite, type UndoOffer, type WriteFailure } from '../lib/undoableWrite.js';
import type { AccountKind } from './useAccountActions.js';

/** The account being moved, with the name to call it by. */
export interface MoveSubject {
  id: string;
  name: string;
  distinguishedName: string;
}

export interface MoveRun {
  account: MoveSubject;
  destinationDn: string;
  /** For an Undo: the OU the move put the account in, where it must still be. */
  whileIn?: string | undefined;
}

export type MoveFailure = WriteFailure<MoveRun>;

const ACCOUNTS: Record<
  AccountKind,
  {
    get: (id: string) => Promise<MoveSubject>;
    move: (id: string, body: MoveRequest) => Promise<unknown>;
  }
> = {
  user: {
    get: async (id) => {
      const { user: u } = await api.users.get(id);
      return {
        id: u.id,
        name: u.displayName ?? u.samAccountName,
        distinguishedName: u.distinguishedName,
      };
    },
    move: (id, body) => api.users.move(id, body),
  },
  computer: {
    get: async (id) => {
      const { computer: c } = await api.computers.get(id);
      return {
        id: c.id,
        name: computerName(c),
        distinguishedName: c.distinguishedName,
      };
    },
    move: (id, body) => api.computers.move(id, body),
  },
};

/**
 * Pick an OU and move a user (or, with `kind`, a computer) there.
 * `onMoved` gets the offer of Undo, which moves the account back the same
 * way, unless it came from somewhere that isn't one of the OUs (a container
 * such as CN=Users). An Undo first checks the account is still where the
 * move put it. `error` says why the account or the OUs couldn't be read; a
 * failed move stays in `failure` until it's retried, dismissed or the next
 * load.
 */
export function useAccountMove(options: {
  kind?: AccountKind;
  onMoved: (account: MoveSubject, destinationDn: string, offer: UndoOffer) => void | Promise<void>;
  onFailed?: (failure: MoveFailure) => void | Promise<void>;
}) {
  const accounts = ACCOUNTS[options.kind ?? 'user'];
  const account = ref<MoveSubject | null>(null);
  const ous = ref<DirectoryOu[]>([]);
  const loading = ref(false);
  const destination = ref<string | null>(null);
  const error = ref<string | null>(null);
  const loads = latestRequest();

  const writes = useUndoableWrite<MoveRun>({
    write: async ({ account: a, destinationDn, whileIn }) => {
      if (whileIn) {
        const now = await accounts.get(a.id);
        if (!sameDn(parentOf(now.distinguishedName) ?? '', whileIn)) {
          throw new Error(`${a.name} has been moved again since, so it wasn’t moved back.`);
        }
      }
      await accounts.move(a.id, { targetOuDn: destinationDn });
    },
    inverse: ({ account: a, destinationDn }) => {
      const from = parentOf(a.distinguishedName);
      const ou = from ? ous.value.find((o) => sameDn(o.distinguishedName, from)) : undefined;
      if (!ou) {
        return {
          cannotUndo: `It came from ${from ?? 'the domain root'}, which isn’t an OU, so it can’t be moved back from here.`,
        };
      }
      return { account: a, destinationDn: ou.distinguishedName, whileIn: destinationDn };
    },
    onDone: ({ account: a, destinationDn }, offer) => options.onMoved(a, destinationDn, offer),
    onFailed: options.onFailed,
  });
  const submitting = computed(() => writes.runningOn() !== null);

  const currentOuDn = computed(() =>
    account.value ? parentOf(account.value.distinguishedName) : null,
  );
  const atCurrent = computed(
    () =>
      destination.value !== null &&
      currentOuDn.value !== null &&
      sameDn(destination.value, currentOuDn.value),
  );
  const ready = computed(
    () => !!account.value && destination.value !== null && !atCurrent.value && !submitting.value,
  );

  // Reads the account even when the caller has it, so the current OU is
  // where it is now rather than where it was when the caller read it.
  async function load(id: string): Promise<void> {
    const isCurrent = loads.begin();
    account.value = null;
    ous.value = [];
    destination.value = null;
    error.value = null;
    writes.dismiss();
    loading.value = true;
    try {
      const [a, list] = await Promise.all([accounts.get(id), api.ous.list()]);
      if (!isCurrent()) return;
      account.value = a;
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
    writes.run({ account: account.value!, destinationDn: destination.value! });
  }

  /** The OU's name, for saying where an account went. */
  function ouName(dn: string): string {
    return ous.value.find((o) => sameDn(o.distinguishedName, dn))?.name ?? dn;
  }

  return {
    account,
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
