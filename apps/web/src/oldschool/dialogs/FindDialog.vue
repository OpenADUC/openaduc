<!-- SPDX-License-Identifier: BUSL-1.1
     Mini Find dialog. Searches users/groups/computers by name fragment.
     Results in a classic listbox; double-click opens the Properties
     dialog for the row. Intentionally lighter than the real "Find Users,
     Contacts, and Groups" dialog — we keep the field set small enough to
     feel responsive without re-implementing the saved-query feature. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useDirectorySearch } from '../../design/composables/useDirectorySearch.js';

defineProps<{ windowId: number }>();
defineEmits<{ (e: 'close'): void }>();
const store = useOldSchool();
const finder = useDirectorySearch({ pageSize: 100 });
const { loading } = finder;

type Kind = 'user' | 'group' | 'computer';
const KINDS = (
  [
    { kind: 'user', label: 'Users' },
    { kind: 'group', label: 'Groups' },
    { kind: 'computer', label: 'Computers' },
  ] as const
).filter((k) => finder.canSearch(k.kind));

const kind = ref<Kind>(KINDS[0]?.kind ?? 'user');
const q = ref('');

interface Hit {
  kind: Kind;
  id: string;
  name: string;
  description: string;
}
const hits = computed<Hit[]>(() => {
  const found = finder.results.value;
  return [
    ...found.user.map<Hit>((u) => ({
      kind: 'user',
      id: u.id,
      name: u.displayName || u.samAccountName,
      description: u.email ?? u.userPrincipalName ?? '',
    })),
    ...found.group.map<Hit>((g) => ({
      kind: 'group',
      id: g.id,
      name: g.name ?? g.samAccountName ?? '(unnamed)',
      description: g.description ?? '',
    })),
    ...found.computer.map<Hit>((c) => ({
      kind: 'computer',
      id: c.id,
      name: c.name ?? '(unnamed)',
      description: c.operatingSystem ?? c.dnsHostName ?? '',
    })),
  ];
});
const failed = computed(() => finder.failed.value.length > 0);
const selectedId = ref<string | null>(null);

function run(): void {
  void finder.search(q.value, [kind.value]);
}

// 300ms debounce on q and immediate refresh on kind change.
let timer: ReturnType<typeof setTimeout> | null = null;
watch(q, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, 300);
});
watch(kind, () => {
  finder.clear();
  if (q.value.trim()) run();
});

function openHit(h: Hit): void {
  if (h.kind === 'user') store.openDialog({ kind: 'user-properties', id: h.id });
  else if (h.kind === 'group') store.openDialog({ kind: 'group-properties', id: h.id });
  else store.openDialog({ kind: 'computer-properties', id: h.id });
}
</script>

<template>
  <WinDialog
    :window-id="windowId"
    title="Find Users, Contacts, and Groups"
    icon="find"
    hide-apply
    ok-label="Find Now"
    cancel-label="Close"
    :can-ok="!!q.trim()"
    @ok="run"
    @cancel="$emit('close')"
    @close="$emit('close')"
  >
    <div style="padding: 14px 16px">
      <div class="os-form" style="grid-template-columns: 110px minmax(0, 1fr)">
        <label class="label" for="findKind">Find:</label>
        <select id="findKind" class="os-select" v-model="kind">
          <option v-for="k in KINDS" :key="k.kind" :value="k.kind">{{ k.label }}</option>
        </select>
        <label class="label" for="findName">Name:</label>
        <input id="findName" class="os-input" v-model="q" placeholder="Start typing…" />
      </div>

      <div class="os-listbox" style="margin-top: 14px; min-height: 200px; max-height: 280px">
        <div v-if="loading && hits.length === 0" class="os-listbox-empty">Searching…</div>
        <div v-else-if="!q.trim()" class="os-listbox-empty">Enter a name to search.</div>
        <div v-else-if="failed && !loading" class="os-listbox-empty os-error">
          The search failed. Try again.
        </div>
        <div v-else-if="hits.length === 0" class="os-listbox-empty">No matches.</div>
        <div
          v-for="h in hits"
          :key="`${h.kind}:${h.id}`"
          class="os-listbox-row"
          :class="{ selected: selectedId === h.id }"
          @click="selectedId = h.id"
          @dblclick="openHit(h)"
        >
          <WinIcon
            :name="h.kind === 'user' ? 'user' : h.kind === 'group' ? 'group' : 'computer'"
            :size="14"
          />
          <span style="flex: 1; overflow: hidden; text-overflow: ellipsis">{{ h.name }}</span>
          <span style="color: var(--os-window-text-muted)">{{ h.description }}</span>
        </div>
      </div>
      <div class="os-info">Double-click a result to open its Properties.</div>
    </div>
  </WinDialog>
</template>
