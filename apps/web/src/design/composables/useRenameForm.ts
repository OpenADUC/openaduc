// SPDX-License-Identifier: BUSL-1.1
// Form state behind both rename dialogs (the modern one and the Old School
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

export const DERIVED_FIELDS: readonly RenameField[] = [
  'displayName',
  'cn',
  'userPrincipalName',
  'samAccountName',
  'email',
];

export function useRenameForm() {
  const user = ref<UserDetail | null>(null);
  const original = ref<RenameIdentity>(emptyIdentity());
  const form = reactive<RenameIdentity>(emptyIdentity());
  const touched = ref(new Set<RenameField>());
  const unresolved = ref(new Set<RenameField>());
  const keepOldEmailAsAlias = ref(true);

  function reset(u: UserDetail | null): void {
    user.value = u;
    const initial: RenameIdentity = u
      ? {
          givenName: u.givenName,
          surname: u.surname,
          displayName: u.displayName,
          cn: rawScalar(u.rawAttributes['cn']),
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
    const raw = user.value?.rawAttributes['proxyAddresses'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.some((p) => typeof p === 'string' && p.startsWith('SMTP:'));
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
    buildRequest,
  };
}

function norm(v: string | null): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

function rawScalar(v: unknown): string | null {
  const value = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof value === 'string' && value.length > 0 ? value : null;
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
