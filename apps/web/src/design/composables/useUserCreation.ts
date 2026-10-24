// SPDX-License-Identifier: BUSL-1.1
// The create-user form behind New user, opened from the user list or from
// an OU, and the start of copying a user and of an import.
//
// The account's names come from the naming check, run as the operator
// types: the pattern's suggestion, unique against the directory, or the
// names the operator typed instead, checked as typed. What's ready, what
// needs approving and what blocks is planNewUser's call, so every way of
// creating a user decides alike. The create runs AD's steps in order; if
// one fails after the account exists, the workflow keeps the account and
// offers to run what's left.

import { computed, reactive, ref, watch } from 'vue';
import {
  DEFAULT_NEW_USER_SETTINGS,
  NOTHING_TAKEN,
  approvalKey,
  generatePassword,
  needsApproval,
  planNewUser,
  resolveNames,
  type DirectoryPolicy,
  type NamingDeviation,
  type NamingRequest,
  type NamingSettings,
  type NamingSuggestion,
  type NewUserForm,
  type NewUserSettings,
  type PasswordMode,
  type UserCreateResponse,
  type UserCreateStep,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { errorMessage } from '../lib/errorMessage.js';
import { latestRequest } from '../lib/latestRequest.js';

const CHECK_DELAY_MS = 300;

export const STEP_LABEL: Record<UserCreateStep, string> = {
  create: 'create the account',
  password: 'set its password',
  enable: 'enable it',
};

function blankForm(): NewUserForm {
  return {
    ouDn: null,
    first: '',
    last: '',
    middleInitial: '',
    preferredFirst: '',
    personalEmail: '',
    mobile: '',
    telephoneNumber: '',
    mailFromUpn: DEFAULT_NEW_USER_SETTINGS.mailFromUpn,
    passwordMode: DEFAULT_NEW_USER_SETTINGS.passwordMode,
    password: '',
    mustChange: true,
    enabled: true,
  };
}

export function useUserCreation(options: {
  onCreated: (created: UserCreateResponse) => void | Promise<void>;
}) {
  const auth = useAuthStore();
  const form = reactive<NewUserForm>(blankForm());
  // Names the operator typed in place of the suggestion; null follows it.
  const typed = reactive({
    samAccountName: null as string | null,
    upnLocal: null as string | null,
    upnSuffix: null as string | null,
    displayName: null as string | null,
  });
  const naming = ref<NamingSettings | null>(null);
  const upnSuffixes = ref<string[]>([]);
  const settings = ref<NewUserSettings>({ ...DEFAULT_NEW_USER_SETTINGS });
  const policy = ref<DirectoryPolicy | null>(null);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const approved = ref(new Set<string>());
  const shown = ref(false);
  const copied = ref<boolean | null>(null);
  const submitting = ref(false);
  const error = ref<string | null>(null);
  /** A create that made the account but didn't finish it. */
  const unfinished = ref<UserCreateResponse | null>(null);

  /**
   * Start a new form: `initial` prefills it (the OU started from, or what
   * a copy carries over); the directory's defaults fill the rest.
   */
  async function start(initial: Partial<NewUserForm> = {}): Promise<void> {
    Object.assign(form, blankForm(), initial);
    Object.assign(typed, {
      samAccountName: null,
      upnLocal: null,
      upnSuffix: null,
      displayName: null,
    });
    approved.value = new Set();
    shown.value = false;
    copied.value = null;
    error.value = null;
    unfinished.value = null;
    loadError.value = null;
    const directoryId = auth.actor?.directoryId;
    if (!directoryId) return;
    loading.value = true;
    try {
      const [n, u, p] = await Promise.all([
        api.directories.naming.get(directoryId),
        api.directories.newUsers.get(directoryId),
        // Without the policy the check still applies the API's minimum and
        // assumes complexity.
        api.directories.policy(directoryId).then(
          (r) => r.policy,
          () => null,
        ),
      ]);
      naming.value = n.naming;
      upnSuffixes.value = n.upnSuffixes;
      settings.value = u.newUsers;
      policy.value = p;
      if (initial.mailFromUpn === undefined) form.mailFromUpn = u.newUsers.mailFromUpn;
      if (initial.passwordMode === undefined) setPasswordMode(u.newUsers.passwordMode);
    } catch (err) {
      loadError.value = errorMessage(err, 'Couldn’t load the naming pattern');
    } finally {
      loading.value = false;
    }
  }

  // ---- Names ---------------------------------------------------------------

  const typedUpn = computed(() =>
    typed.upnLocal !== null || typed.upnSuffix !== null
      ? `${typed.upnLocal ?? ''}@${typed.upnSuffix ?? naming.value?.upnSuffix ?? ''}`
      : null,
  );
  const namingRequest = computed<NamingRequest>(() => ({
    name: {
      first: form.first.trim(),
      last: form.last.trim(),
      middleInitial: form.middleInitial.trim() || null,
      preferredFirst: form.preferredFirst.trim() || null,
    },
    ...(form.ouDn ? { ouDn: form.ouDn } : {}),
    overrides: {
      samAccountName: typed.samAccountName,
      userPrincipalName: typedUpn.value,
      displayName: typed.displayName,
    },
  }));
  const checkable = computed(() => !!naming.value && !!form.first.trim() && !!form.last.trim());
  const subjectKey = () => JSON.stringify(namingRequest.value);
  const checkedKey = ref<string | null>(null);
  const checked = ref<NamingSuggestion | null>(null);
  const checkError = ref<string | null>(null);
  const checks = latestRequest();
  let timer: ReturnType<typeof setTimeout> | undefined;

  watch(subjectKey, (key) => {
    clearTimeout(timer);
    const isCurrent = checks.begin();
    if (!checkable.value) return;
    timer = setTimeout(async () => {
      const request = namingRequest.value;
      const directoryId = auth.actor?.directoryId;
      try {
        if (!directoryId) throw new Error('not signed in to a directory');
        const r = await api.directories.naming.check(directoryId, {
          names: [
            {
              ...request.name,
              ...(request.ouDn ? { ouDn: request.ouDn } : {}),
              overrides: request.overrides,
            },
          ],
        });
        if (!isCurrent()) return;
        checked.value = r.suggestions[0] ?? null;
        checkError.value = null;
      } catch (err) {
        if (!isCurrent()) return;
        // The create checks the names again; meanwhile the pattern and the
        // typed names' own rules still apply.
        checked.value = resolveNames(
          [request],
          naming.value!,
          NOTHING_TAKEN,
          upnSuffixes.value,
        )[0]!;
        checkError.value = errorMessage(err, 'Couldn’t check the names');
      }
      checkedKey.value = key;
    }, CHECK_DELAY_MS);
  });

  const current = computed(() => checkedKey.value === subjectKey());
  const checking = computed(() => checkable.value && !current.value);
  const suggestion = computed(() => (current.value ? checked.value : null));

  // What each name field shows: the typed value, else the latest suggestion.
  const names = computed(() => {
    const s = checked.value;
    const upn = s?.upn ?? '';
    return {
      samAccountName: typed.samAccountName ?? s?.samAccountName ?? '',
      upnLocal: typed.upnLocal ?? s?.upnLocal ?? '',
      upnSuffix:
        typed.upnSuffix ??
        (upn.includes('@') ? upn.slice(upn.lastIndexOf('@') + 1) : (naming.value?.upnSuffix ?? '')),
      displayName: typed.displayName ?? s?.displayName ?? '',
      cn: s?.cn ?? '',
    };
  });
  const usesMiddleInitial = computed(() => !!naming.value?.pattern.includes('{mi}'));

  function setSamAccountName(value: string | undefined): void {
    typed.samAccountName = value?.trim() ? value : null;
  }
  function setUpnLocal(value: string | undefined): void {
    typed.upnLocal = value?.trim() ? value : null;
    if (typed.upnLocal === null) typed.upnSuffix = null;
  }
  /** Picking a suffix keeps the name before the @ as it is now. */
  function setUpnSuffix(value: string | undefined): void {
    if (!value) return;
    typed.upnLocal = names.value.upnLocal;
    typed.upnSuffix = value;
  }
  function setDisplayName(value: string | undefined): void {
    typed.displayName = value?.trim() ? value : null;
  }
  /** Go back to the pattern's names. */
  function useSuggestedNames(): void {
    Object.assign(typed, {
      samAccountName: null,
      upnLocal: null,
      upnSuffix: null,
      displayName: null,
    });
  }
  const namesTyped = computed(
    () => typed.samAccountName !== null || typed.upnLocal !== null || typed.displayName !== null,
  );

  function approve(deviation: NamingDeviation, yes = true): void {
    const next = new Set(approved.value);
    if (yes) next.add(approvalKey(deviation));
    else next.delete(approvalKey(deviation));
    approved.value = next;
  }
  const isApproved = (deviation: NamingDeviation) => approved.value.has(approvalKey(deviation));
  /** The deviations shown with the names, each with whether it needs approving. */
  const deviations = computed(() =>
    (checked.value?.deviations ?? []).map((d) => ({
      deviation: d,
      needsApproval: needsApproval(d),
    })),
  );

  // ---- Plan ----------------------------------------------------------------

  const plan = computed(() =>
    planNewUser(form, {
      suggestion: suggestion.value,
      approved: approved.value,
      policy: policy.value,
      phoneCountry: settings.value.phoneCountry,
    }),
  );

  /** Show each phone number as it will be written, keeping one it can't read as typed. */
  function tidyPhones(): void {
    form.mobile = plan.value.mobile.value;
    form.telephoneNumber = plan.value.telephoneNumber.value;
  }

  // ---- Password ------------------------------------------------------------

  watch(
    () => form.password,
    () => (copied.value = null),
  );

  function setPasswordMode(mode: PasswordMode): void {
    form.passwordMode = mode;
    form.password = '';
    shown.value = false;
    form.mustChange = true;
    if (mode === 'generate') generate();
  }

  function generate(): void {
    form.password = generatePassword(policy.value, {
      samAccountName: names.value.samAccountName || null,
      displayName: names.value.displayName || null,
    });
    shown.value = true;
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(form.password);
      copied.value = true;
    } catch {
      copied.value = false;
    }
  }

  // ---- Submit --------------------------------------------------------------

  const canSubmit = computed(
    () => !!plan.value.request && !submitting.value && !unfinished.value && !loading.value,
  );

  function submit(): void {
    if (canSubmit.value) {
      auth.requireStepUp(commit, 'Creating a user requires step-up authentication.');
    }
  }

  async function commit(): Promise<void> {
    const request = plan.value.request;
    if (!request || submitting.value || unfinished.value) return;
    submitting.value = true;
    error.value = null;
    try {
      await settle(await api.users.create(request));
    } catch (err) {
      if (auth.retryAfterStepUp(err, commit)) return;
      error.value = errorMessage(err, 'Create failed');
    } finally {
      submitting.value = false;
    }
  }

  async function settle(r: UserCreateResponse): Promise<void> {
    if (r.remaining.length === 0) {
      unfinished.value = null;
      await options.onCreated(r);
    } else {
      unfinished.value = r;
    }
  }

  // ---- Finishing an unfinished create --------------------------------------

  const passwordLeft = computed(() => !!unfinished.value?.remaining.includes('password'));
  const canFinish = computed(
    () =>
      !!unfinished.value?.id && !submitting.value && (!passwordLeft.value || !!plan.value.password),
  );

  function finish(): void {
    if (canFinish.value) {
      auth.requireStepUp(finishCommit, 'Creating a user requires step-up authentication.');
    }
  }

  async function finishCommit(): Promise<void> {
    const left = unfinished.value;
    if (!left?.id || submitting.value) return;
    submitting.value = true;
    error.value = null;
    try {
      await settle(
        await api.users.finishCreate(left.id, {
          ...(passwordLeft.value && plan.value.password ? { password: plan.value.password } : {}),
          enabled: form.enabled,
        }),
      );
    } catch (err) {
      if (auth.retryAfterStepUp(err, finishCommit)) return;
      error.value = errorMessage(err, 'Couldn’t finish creating the account');
    } finally {
      submitting.value = false;
    }
  }

  /** Leave the account as it is and go to it. */
  async function openUnfinished(): Promise<void> {
    if (unfinished.value) await options.onCreated(unfinished.value);
  }

  /** What an unfinished create did and what's left, for the operator. */
  const unfinishedSummary = computed(() => {
    const u = unfinished.value;
    if (!u) return null;
    const failed = u.failure ? `Couldn’t ${STEP_LABEL[u.failure.step]}: ${u.failure.message}` : '';
    const left = u.remaining.map((s) => STEP_LABEL[s]).join(', then ');
    return {
      title: `${u.samAccountName} exists, but it’s disabled.`,
      failed,
      left: `Still to do: ${left}.`,
    };
  });

  return {
    form,
    start,
    loading,
    loadError,
    naming,
    upnSuffixes,
    settings,
    names,
    usesMiddleInitial,
    setSamAccountName,
    setUpnLocal,
    setUpnSuffix,
    setDisplayName,
    useSuggestedNames,
    namesTyped,
    checking,
    checkError: computed(() => (current.value ? checkError.value : null)),
    deviations,
    approve,
    isApproved,
    plan,
    tidyPhones,
    setPasswordMode,
    generate,
    shown,
    copied,
    copy,
    canSubmit,
    submitting,
    error,
    submit,
    unfinished,
    unfinishedSummary,
    passwordLeft,
    canFinish,
    finish,
    openUnfinished,
  };
}
