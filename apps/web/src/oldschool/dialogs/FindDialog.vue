<!-- SPDX-License-Identifier: BUSL-1.1
     Mini Find dialog. Searches users/groups/computers by name fragment.
     Results in a classic listbox; double-click opens the Properties
     dialog for the row. Intentionally lighter than the real "Find Users,
     Contacts, and Groups" dialog — we keep the field set small enough to
     feel responsive without re-implementing the saved-query feature. -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { api } from '../../api/index.js';
import { useOldSchool } from '../stores/useOldSchool.js';

defineEmits<{ (e: 'close'): void }>();
const visible = ref(true);
const store = useOldSchool();

const kind = ref<'user' | 'group' | 'computer'>('user');
const q = ref('');
const loading = ref(false);

interface Hit {
  kind: 'user' | 'group' | 'computer';
  id: string;
  name: string;
  description: string;
}
const hits = ref<Hit[]>([]);
const selectedId = ref<string | null>(null);
let searchToken = 0;

async function run(): Promise<void> {
  const trimmed = q.value.trim();
  if (!trimmed) {
    hits.value = [];
    return;
  }
  const token = ++searchToken;
  loading.value = true;
  try {
    if (kind.value === 'user') {
      const resp = await api.users.search({ q: trimmed, pageSize: 100 });
      if (token !== searchToken) return;
      hits.value = resp.rows.map((u) => ({
        kind: 'user',
        id: u.id,
        name: u.displayName || u.samAccountName,
        description: u.email ?? u.userPrincipalName ?? '',
      }));
    } else if (kind.value === 'group') {
      const resp = await api.groups.search({ q: trimmed, pageSize: 100 });
      if (token !== searchToken) return;
      hits.value = resp.rows.map((g) => ({
        kind: 'group',
        id: g.id,
        name: g.name ?? g.samAccountName ?? '(unnamed)',
        description: g.description ?? '',
      }));
    } else {
      const resp = await api.computers.search({ q: trimmed, pageSize: 100 });
      if (token !== searchToken) return;
      hits.value = resp.rows.map((c) => ({
        kind: 'computer',
        id: c.id,
        name: c.name ?? '(unnamed)',
        description: c.operatingSystem ?? c.dnsHostName ?? '',
      }));
    }
  } finally {
    if (token === searchToken) loading.value = false;
  }
}

// 300ms debounce on q and immediate refresh on kind change.
let timer: ReturnType<typeof setTimeout> | null = null;
watch(q, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, 300);
});
watch(kind, () => {
  hits.value = [];
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
    :visible="visible"
    title="Find Users, Contacts, and Groups"
    icon="find"
    :width="560"
    hide-apply
    ok-label="Find Now"
    cancel-label="Close"
    :can-ok="!!q.trim()"
    @ok="run"
    @cancel="$emit('close')"
    @update:visible="(v) => !v && $emit('close')"
  >
    <div style="padding: 14px 16px">
      <div class="os-form" style="grid-template-columns: 110px 1fr">
        <label class="label" for="findKind">Find:</label>
        <select id="findKind" class="os-select" v-model="kind">
          <option value="user">Users</option>
          <option value="group">Groups</option>
          <option value="computer">Computers</option>
        </select>
        <label class="label" for="findName">Name:</label>
        <input id="findName" class="os-input" v-model="q" placeholder="Start typing…" />
      </div>

      <div class="os-listbox" style="margin-top: 14px; min-height: 200px; max-height: 280px">
        <div v-if="loading && hits.length === 0" class="os-listbox-empty">Searching…</div>
        <div v-else-if="!q.trim()" class="os-listbox-empty">Enter a name to search.</div>
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
