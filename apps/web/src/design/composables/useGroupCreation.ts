// SPDX-License-Identifier: BUSL-1.1
// The create-group form behind the New group dialog, opened from the group
// list or from an OU.
//
// The pre-Windows 2000 name follows the name, as in ADUC, until the
// operator edits it. Names are checked as the operator types: against AD's
// rules here, and against the directory (the name among the OU's children,
// the pre-Windows 2000 name across the domain) by the server, so a taken
// name shows before submit. The create checks again.

import { computed, reactive, ref, watch } from 'vue';
import {
  groupNameSchema,
  groupSamAccountNameSchema,
  type GroupCreateResponse,
  type GroupScope,
  type GroupType,
} from '@openaduc/shared';
import type { ZodType } from 'zod';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { errorMessage } from '../lib/errorMessage.js';
import { latestRequest } from '../lib/latestRequest.js';

const CHECK_DELAY_MS = 300;
const LEGACY_SAM_LENGTH = 20;

export const SCOPE_LABEL: Record<GroupScope, string> = {
  'domain-local': 'Domain local',
  global: 'Global',
  universal: 'Universal',
};

export const TYPE_LABEL: Record<GroupType, string> = {
  security: 'Security',
  distribution: 'Distribution',
};

export function useGroupCreation(options: {
  onCreated: (created: GroupCreateResponse) => void | Promise<void>;
}) {
  const auth = useAuthStore();
  const form = reactive({
    parentDn: null as string | null,
    name: '',
    samAccountName: '',
    description: '',
    scope: 'global' as GroupScope,
    type: 'security' as GroupType,
  });
  const samTouched = ref(false);
  const submitting = ref(false);
  const error = ref<string | null>(null);

  function reset(parentDn: string | null): void {
    Object.assign(form, {
      parentDn,
      name: '',
      samAccountName: '',
      description: '',
      scope: 'global',
      type: 'security',
    });
    samTouched.value = false;
    error.value = null;
  }

  function setName(value: string | undefined): void {
    form.name = value ?? '';
    if (!samTouched.value) form.samAccountName = form.name.trim();
  }

  function setSamAccountName(value: string | undefined): void {
    form.samAccountName = value ?? '';
    samTouched.value = true;
  }

  // Empty fields aren't problems to report, just not ready to submit.
  const problems = computed(() => ({
    name: ruleBroken(groupNameSchema, form.name),
    samAccountName: ruleBroken(groupSamAccountNameSchema, form.samAccountName),
  }));
  // AD takes up to 256, but clients from before Windows 2000 (and some
  // tools that still use the NetBIOS-era APIs) stop at 20. Worth saying,
  // not refusing.
  const samLegacyWarning = computed(() =>
    form.samAccountName.trim().length > LEGACY_SAM_LENGTH && !problems.value.samAccountName
      ? `Longer than ${LEGACY_SAM_LENGTH} characters: clients older than Windows 2000 can’t use it.`
      : null,
  );
  const wellFormed = computed(
    () =>
      !!form.parentDn &&
      !!form.name.trim() &&
      !!form.samAccountName.trim() &&
      !problems.value.name &&
      !problems.value.samAccountName,
  );

  // ---- Name check -----------------------------------------------------------

  const subjectKey = () =>
    JSON.stringify([form.parentDn, form.name.trim(), form.samAccountName.trim()]);
  const checkedKey = ref<string | null>(null);
  // Who holds each name: null when free; `dn` null when the holder is
  // outside the directory's base DN and the server won't say.
  type Holder = { dn: string | null } | null;
  const holders = ref<{ name: Holder; samAccountName: Holder }>({
    name: null,
    samAccountName: null,
  });
  const checkError = ref<string | null>(null);
  const checks = latestRequest();
  let timer: ReturnType<typeof setTimeout> | undefined;

  watch(subjectKey, (key) => {
    clearTimeout(timer);
    const isCurrent = checks.begin();
    if (!wellFormed.value) return;
    timer = setTimeout(async () => {
      try {
        const r = await api.groups.nameCheck({
          parentDn: form.parentDn!,
          name: form.name.trim(),
          samAccountName: form.samAccountName.trim(),
        });
        if (!isCurrent()) return;
        holders.value = {
          name: r.nameTaken ? { dn: r.nameTakenBy } : null,
          samAccountName: r.samAccountNameTaken ? { dn: r.samAccountNameTakenBy } : null,
        };
        checkError.value = null;
      } catch (err) {
        if (!isCurrent()) return;
        // The create checks again, so a failed check doesn't block it.
        holders.value = { name: null, samAccountName: null };
        checkError.value = errorMessage(err, 'Couldn’t check the names');
      }
      checkedKey.value = key;
    }, CHECK_DELAY_MS);
  });

  const current = computed(() => checkedKey.value === subjectKey());
  const checking = computed(() => wellFormed.value && !current.value);
  /** Why each name can't be used, from a check of the values on screen. */
  const taken = computed(() => {
    const h = current.value ? holders.value : { name: null, samAccountName: null };
    return {
      name: h.name ? `Already used in this OU${h.name.dn ? ` by ${h.name.dn}` : ''}` : null,
      samAccountName: h.samAccountName
        ? h.samAccountName.dn
          ? `Already used in the domain by ${h.samAccountName.dn}`
          : 'Already used elsewhere in the domain'
        : null,
    };
  });

  const canSubmit = computed(
    () =>
      wellFormed.value &&
      current.value &&
      !taken.value.name &&
      !taken.value.samAccountName &&
      !submitting.value,
  );

  // ---- Submit ---------------------------------------------------------------

  function submit(): void {
    if (canSubmit.value) {
      auth.requireStepUp(commit, 'Creating a group requires step-up authentication.');
    }
  }

  async function commit(): Promise<void> {
    if (!wellFormed.value || submitting.value) return;
    submitting.value = true;
    error.value = null;
    try {
      const created = await api.groups.create({
        parentDn: form.parentDn!,
        name: form.name.trim(),
        samAccountName: form.samAccountName.trim(),
        description: form.description.trim() || null,
        scope: form.scope,
        type: form.type,
      });
      await options.onCreated(created);
    } catch (err) {
      if (auth.retryAfterStepUp(err, commit)) return;
      error.value = errorMessage(err, 'Create failed');
    } finally {
      submitting.value = false;
    }
  }

  return {
    form,
    reset,
    setName,
    setSamAccountName,
    problems,
    samLegacyWarning,
    checking,
    checkError: computed(() => (current.value ? checkError.value : null)),
    taken,
    canSubmit,
    submitting,
    error,
    submit,
  };
}

function ruleBroken(schema: ZodType, value: string): string | null {
  if (!value.trim()) return null;
  const r = schema.safeParse(value);
  return r.success ? null : (r.error.issues[0]?.message ?? 'invalid');
}
