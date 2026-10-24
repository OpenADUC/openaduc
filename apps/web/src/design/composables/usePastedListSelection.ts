// SPDX-License-Identifier: BUSL-1.1
// An entry that could mean several people counts once the operator picks
// one; until then it's skipped, like an entry that matched nobody. A
// matched user the list hasn't loaded (the cache changed since) is left
// out of the selection, since the bulk actions work from loaded rows.

import { computed, ref, type Ref } from 'vue';
import {
  MAX_USER_MATCH_ENTRIES,
  type UserMatchCandidate,
  type UserMatchResult,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { errorMessage } from '../lib/errorMessage.js';
import { latestRequest } from '../lib/latestRequest.js';
import { parsePastedList } from '../lib/pastedList.js';

type Of<S extends UserMatchResult['status']> = Extract<UserMatchResult, { status: S }>;

export function usePastedListSelection(opts: {
  selectedIds: Ref<Set<string>>;
  isLoaded: (id: string) => boolean;
}) {
  const text = ref('');
  const phase = ref<'editing' | 'matching' | 'review'>('editing');
  const error = ref<string | null>(null);
  const results = ref<UserMatchResult[]>([]);
  // Ambiguous entry → the user the operator picked for it.
  const picks = ref(new Map<string, string>());
  const guard = latestRequest();

  const entries = computed(() => parsePastedList(text.value));
  const tooMany = computed(() => entries.value.length > MAX_USER_MATCH_ENTRIES);

  const of = <S extends UserMatchResult['status']>(status: S) =>
    computed(() => results.value.filter((r): r is Of<S> => r.status === status));
  const matched = of('matched');
  const ambiguous = of('ambiguous');
  const unmatched = of('unmatched');
  const unresolved = computed(
    () => ambiguous.value.filter((r) => !picks.value.has(r.entry)).length,
  );

  // Everyone the matches and picks name, loaded or not.
  const found = computed(() => {
    const users = new Map<string, UserMatchCandidate>();
    for (const r of matched.value) users.set(r.user.id, r.user);
    for (const r of ambiguous.value) {
      const user = r.candidates.find((c) => c.id === picks.value.get(r.entry));
      if (user) users.set(user.id, user);
    }
    return [...users.values()];
  });
  const notLoaded = computed(() => found.value.filter((u) => !opts.isLoaded(u.id)).length);
  const selection = computed(() => found.value.filter((u) => opts.isLoaded(u.id)).map((u) => u.id));
  const disabled = computed(
    () => found.value.filter((u) => !u.enabled && opts.isLoaded(u.id)).length,
  );

  async function match(): Promise<void> {
    if (entries.value.length === 0 || tooMany.value || phase.value === 'matching') return;
    const isCurrent = guard.begin();
    phase.value = 'matching';
    error.value = null;
    try {
      const res = await api.users.match(entries.value);
      if (!isCurrent()) return;
      results.value = res.results;
      picks.value = new Map();
      phase.value = 'review';
    } catch (err) {
      if (!isCurrent()) return;
      error.value = errorMessage(err, "Couldn't match the list.");
      phase.value = 'editing';
    }
  }

  function pick(entry: string, id: string | null): void {
    const next = new Map(picks.value);
    if (id) next.set(entry, id);
    else next.delete(entry);
    picks.value = next;
  }

  function edit(): void {
    guard.begin();
    phase.value = 'editing';
    results.value = [];
    picks.value = new Map();
  }

  function reset(): void {
    edit();
    text.value = '';
    error.value = null;
  }

  function apply(mode: 'replace' | 'add'): void {
    opts.selectedIds.value = new Set([
      ...(mode === 'add' ? opts.selectedIds.value : []),
      ...selection.value,
    ]);
  }

  return {
    text,
    entries,
    tooMany,
    phase,
    error,
    results,
    matched,
    ambiguous,
    unmatched,
    unresolved,
    picks,
    selection,
    notLoaded,
    disabled,
    match,
    pick,
    edit,
    reset,
    apply,
  };
}
