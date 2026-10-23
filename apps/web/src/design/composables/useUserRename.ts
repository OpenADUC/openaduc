// SPDX-License-Identifier: BUSL-1.1
// The rename behind both rename dialogs (the modern one and the Old School
// "Rename User" window).
//
// Typing a new first or last name fills in the other fields by following
// the pattern each one uses today (see suggestRenamedIdentity). A field the
// operator edits by hand stops following. Fields whose pattern couldn't be
// worked out keep their old value and land in `unresolved`.

import { computed, reactive, ref } from 'vue';
import {
  suggestRenamedIdentity,
  type RenameField,
  type RenameIdentity,
  type UserDetail,
  type UserRenameRequest,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { errorMessage } from '../lib/errorMessage.js';

export const DERIVED_FIELDS: readonly RenameField[] = [
  'displayName',
  'cn',
  'userPrincipalName',
  'samAccountName',
  'email',
];

export function useUserRename(options: { onRenamed: () => void | Promise<void> }) {
  const auth = useAuthStore();
  const user = ref<UserDetail | null>(null);
  const original = ref<RenameIdentity>(emptyIdentity());
  const form = reactive<RenameIdentity>(emptyIdentity());
  const touched = ref(new Set<RenameField>());
  const unresolved = ref(new Set<RenameField>());
  const keepOldEmailAsAlias = ref(true);
  const submitting = ref(false);
  const error = ref<string | null>(null);

  function reset(u: UserDetail | null): void {
    user.value = u;
    const initial: RenameIdentity = u
      ? {
          givenName: u.givenName,
          surname: u.surname,
          displayName: u.displayName,
          cn: u.cn,
          samAccountName: u.samAccountName,
          userPrincipalName: u.userPrincipalName,
          email: u.email,
        }
      : emptyIdentity();
    original.value = initial;
    Object.assign(form, initial);
    touched.value = new Set();
    unresolved.value = new Set();
    keepOldEmailAsAlias.value = true;
    error.value = null;
  }

  function setName(key: 'givenName' | 'surname', value: string | undefined): void {
    form[key] = value ?? '';
    const namesChanged =
      norm(form.givenName) !== norm(original.value.givenName) ||
      norm(form.surname) !== norm(original.value.surname);
    const { values, unresolved: missing } = suggestRenamedIdentity(original.value, {
      givenName: form.givenName ?? '',
      surname: form.surname ?? '',
    });
    for (const f of DERIVED_FIELDS) {
      if (touched.value.has(f)) continue;
      form[f] = namesChanged ? values[f] : original.value[f];
    }
    unresolved.value = new Set(namesChanged ? missing.filter((f) => !touched.value.has(f)) : []);
  }

  function setField(key: RenameField, value: string | undefined): void {
    form[key] = value ?? '';
    touched.value = new Set(touched.value).add(key);
    const next = new Set(unresolved.value);
    next.delete(key);
    unresolved.value = next;
  }

  function changed(key: keyof RenameIdentity): boolean {
    return norm(form[key]) !== norm(original.value[key]);
  }

  const changedKeys = computed(() =>
    (Object.keys(original.value) as (keyof RenameIdentity)[]).filter((k) => changed(k)),
  );

  const logonChanging = computed(() => changed('samAccountName') || changed('userPrincipalName'));

  // proxyAddresses only matter when the account has them (Exchange or
  // Entra-synced mailboxes); otherwise only `mail` changes.
  const hasProxyAddresses = computed(() => {
    return !!user.value?.primarySmtpAddress;
  });

  const offerKeepAlias = computed(
    () => changed('email') && hasProxyAddresses.value && original.value.email !== null,
  );

  function buildRequest(): UserRenameRequest {
    const body: Record<string, unknown> = {};
    for (const key of changedKeys.value) body[key] = norm(form[key]);
    if (offerKeepAlias.value) body['keepOldEmailAsAlias'] = keepOldEmailAsAlias.value;
    return body as UserRenameRequest;
  }

  const ready = () => !!user.value && changedKeys.value.length > 0 && !submitting.value;

  function submit(): void {
    if (ready()) auth.requireStepUp(commit, 'Renaming a user requires step-up authentication.');
  }

  async function commit(): Promise<void> {
    if (!ready()) return;
    submitting.value = true;
    error.value = null;
    try {
      await api.users.rename(user.value!.id, buildRequest());
      await options.onRenamed();
    } catch (err) {
      if (auth.retryAfterStepUp(err, commit)) return;
      error.value = errorMessage(err, 'Rename failed');
    } finally {
      submitting.value = false;
    }
  }

  return {
    original,
    form,
    unresolved,
    keepOldEmailAsAlias,
    reset,
    setName,
    setField,
    changed,
    changedKeys,
    logonChanging,
    offerKeepAlias,
    submitting,
    error,
    submit,
  };
}

function norm(v: string | null): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

function emptyIdentity(): RenameIdentity {
  return {
    givenName: null,
    surname: null,
    displayName: null,
    cn: null,
    samAccountName: null,
    userPrincipalName: null,
    email: null,
  };
}
