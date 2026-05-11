<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Select Groups" / "Add to a group" dialog. Type a name
     fragment, see matches, double-click or OK to add. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';
import type { GroupSummary } from '@openaduc/shared';

const props = defineProps<{ windowId: number; userId: string; userLabel: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const auth = useAuthStore();
const store = useOldSchool();
const toast = useToast();

const q = ref('');
const hits = ref<GroupSummary[]>([]);
const selected = ref<GroupSummary | null>(null);
const loading = ref(false);
const err = ref<string | null>(null);
let token = 0;

async function search(): Promise<void> {
  const trimmed = q.value.trim();
  if (!trimmed) {
    hits.value = [];
    return;
  }
  const t = ++token;
  loading.value = true;
  try {
    const resp = await api.groups.search({ q: trimmed, pageSize: 50 });
    if (t !== token) return;
    hits.value = resp.rows;
  } finally {
    if (t === token) loading.value = false;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
watch(q, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(search, 250);
});

const canOk = computed(() => !!selected.value);

function ok(): void {
  const g = selected.value;
  if (!g) return;
  err.value = null;
  auth.requireEdit(async () => {
    try {
      await api.users.addGroup(props.userId, { groupId: g.id });
      toast.add({
        severity: 'success',
        summary: `${props.userLabel} added to ${g.name ?? g.samAccountName}.`,
        life: 3000,
      });
      store.bumpData();
      emit('close');
    } catch (e) {
      err.value = e instanceof ApiError ? e.message : (e as Error).message;
    }
  }, 'Adding a group membership requires step-up authentication.');
}
</script>

<template>
  <WinDialog
    :window-id="windowId"
    title="Select Groups"
    icon="group"
    hide-apply
    ok-label="OK"
    :can-ok="canOk"
    @ok="ok"
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div style="padding: 14px 16px; font-size: 12px">
      <div style="margin-bottom: 10px">
        Enter the name of a group to add <strong>{{ userLabel }}</strong> to:
      </div>
      <input class="os-input" v-model="q" placeholder="Group name" autofocus />

      <div class="os-listbox" style="margin-top: 10px; min-height: 200px; max-height: 280px">
        <div v-if="loading && hits.length === 0" class="os-listbox-empty">Searching…</div>
        <div v-else-if="!q.trim()" class="os-listbox-empty">Type a group name to search.</div>
        <div v-else-if="hits.length === 0" class="os-listbox-empty">No matches.</div>
        <div
          v-for="g in hits"
          :key="g.id"
          class="os-listbox-row"
          :class="{ selected: selected?.id === g.id }"
          @click="selected = g"
          @dblclick="((selected = g), ok())"
        >
          <WinIcon name="group" :size="14" />
          <span style="flex: 1">{{ g.name ?? g.samAccountName ?? '(unnamed)' }}</span>
          <span style="color: var(--os-window-text-muted)">{{ g.description ?? '' }}</span>
        </div>
      </div>

      <div v-if="err" class="os-error" style="margin-top: 10px">{{ err }}</div>
    </div>
  </WinDialog>
</template>
