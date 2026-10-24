// SPDX-License-Identifier: BUSL-1.1
// Editing a directory's naming pattern and UPN suffix, with a live preview
// of what the pattern on screen makes of some sample names. The preview runs
// the same engine the server checks names with, so what it shows is what a
// create would suggest (before any collision with an existing account).

import { computed, reactive, ref } from 'vue';
import {
  type NamingSettings,
  type NamingSuggestion,
  type PersonName,
  namingPatternProblem,
  suggestNames,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { errorMessage } from '../lib/errorMessage.js';

export const SAMPLE_NAMES: PersonName[] = [
  { first: 'Jane', last: 'Doe' },
  { first: 'José', last: "O'Brien" },
  { first: 'Anna', last: 'van der Berg' },
  { first: 'Robert', last: 'Jones', middleInitial: 'Q', preferredFirst: 'Bob' },
  { first: 'Christopher', last: 'Lee-Vanderberg-Montgomery' },
];

export function useNamingPattern(
  directoryId: number,
  options: { onSaved: (naming: NamingSettings) => void | Promise<void> },
) {
  const auth = useAuthStore();
  const form = reactive<NamingSettings>({ pattern: '', upnSuffix: '' });
  const saved = ref<NamingSettings | null>(null);
  const upnSuffixes = ref<string[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const r = await api.directories.naming.get(directoryId);
      saved.value = r.naming;
      upnSuffixes.value = r.upnSuffixes;
      Object.assign(form, r.naming);
    } catch (err) {
      error.value = errorMessage(err, 'Couldn’t load the naming pattern');
    } finally {
      loading.value = false;
    }
  }

  const entered = computed<NamingSettings>(() => ({
    pattern: form.pattern.trim(),
    upnSuffix: form.upnSuffix,
  }));
  const problem = computed(() => namingPatternProblem(entered.value.pattern));
  const preview = computed<{ name: PersonName; suggestion: NamingSuggestion }[]>(() =>
    problem.value || !entered.value.upnSuffix
      ? []
      : SAMPLE_NAMES.map((name) => ({ name, suggestion: suggestNames(name, entered.value) })),
  );
  const changed = computed(
    () =>
      !!saved.value &&
      (entered.value.pattern !== saved.value.pattern ||
        entered.value.upnSuffix !== saved.value.upnSuffix),
  );

  function save(): void {
    if (problem.value || !changed.value || saving.value) return;
    auth.requireStepUp(commit, 'Changing the naming pattern requires step-up authentication.');
  }

  async function commit(): Promise<void> {
    if (problem.value || saving.value) return;
    saving.value = true;
    error.value = null;
    try {
      const r = await api.directories.naming.update(directoryId, { ...entered.value });
      saved.value = r.naming;
      Object.assign(form, r.naming);
      await options.onSaved(r.naming);
    } catch (err) {
      if (auth.retryAfterStepUp(err, commit)) return;
      error.value = errorMessage(err, 'Save failed');
    } finally {
      saving.value = false;
    }
  }

  return { form, upnSuffixes, loading, problem, preview, changed, saving, error, load, save };
}
