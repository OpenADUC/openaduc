<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Select Groups" / "Add to a group" dialog. Type a name
     fragment, see matches, double-click or OK to add. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';
import { MIN_GROUP_QUERY, useAddToGroup } from '../../design/composables/useAddToGroup.js';
import type { GroupSummary } from '@openaduc/shared';

const props = defineProps<{ windowId: number; userId: string; userLabel: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();

const addError = ref<string | null>(null);
const {
  error: loadError,
  query,
  ready,
  queryTooShort,
  results,
  truncated,
  searching,
  searchError,
  existing,
  adding,
  load,
  add,
} = useAddToGroup({
  onAdded: (m) => {
    toast.add({
      severity: 'success',
      summary: `${m.userLabel} added to ${m.groupLabel}.`,
      life: 3000,
    });
    store.bumpData();
    emit('close');
  },
  onFailed: (message) => {
    addError.value = message;
  },
});
onMounted(() => load(props.userId));

const selected = ref<GroupSummary | null>(null);
const canOk = computed(
  () =>
    !!selected.value && existing(selected.value.id) !== 'direct' && ready.value && !adding.value,
);

function ok(): void {
  if (!canOk.value) return;
  addError.value = null;
  add(selected.value!);
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
      <input class="os-input" v-model="query" placeholder="Group name" autofocus />

      <div class="os-listbox" style="margin-top: 10px; min-height: 200px; max-height: 280px">
        <div v-if="searching && results.length === 0" class="os-listbox-empty">Searching…</div>
        <div v-else-if="queryTooShort" class="os-listbox-empty">
          Type at least {{ MIN_GROUP_QUERY }} characters of a group name.
        </div>
        <div v-else-if="searchError" class="os-listbox-empty">
          The search failed: {{ searchError }}
        </div>
        <div v-else-if="results.length === 0" class="os-listbox-empty">No matches.</div>
        <div
          v-for="g in results"
          :key="g.id"
          class="os-listbox-row"
          :class="{ selected: selected?.id === g.id }"
          @click="selected = g"
          @dblclick="((selected = g), ok())"
        >
          <WinIcon name="group" :size="14" />
          <span style="flex: 1">
            {{ g.name ?? g.samAccountName ?? '(unnamed)' }}
            <template v-if="existing(g.id) === 'direct'"> (already a member)</template>
            <template v-else-if="existing(g.id) === 'nested'">
              (member via a nested group)</template
            >
          </span>
          <span style="color: var(--os-window-text-muted)">{{ g.description ?? '' }}</span>
        </div>
      </div>

      <div v-if="truncated && !searching" class="os-info" style="margin-top: 6px">
        Showing {{ results.length }} — refine your search.
      </div>
      <div v-if="loadError ?? addError" class="os-error" style="margin-top: 10px">
        {{ loadError ?? addError }}
      </div>
    </div>
  </WinDialog>
</template>
