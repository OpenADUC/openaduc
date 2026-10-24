<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Select Groups" / "Add to a group" dialog. Type a name
     fragment, see matches, double-click or OK to add. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useLicensedGroupsStore } from '../../stores/licensedGroups.js';
import { useToast } from 'primevue/usetoast';
import { undoable } from '../../design/feedback/undoToast.js';
import { MIN_GROUP_QUERY, useAddToGroup } from '../../design/composables/useAddToGroup.js';
import {
  membershipChangeText,
  membershipDoneText,
} from '../../design/composables/useGroupMembership.js';
import type { GroupSummary } from '@openaduc/shared';

const props = defineProps<{ windowId: number; userId: string; userLabel: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();

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
  // Runs for an Undo too, after this dialog has closed.
  onChanged: (change, m, offer) => {
    toast.add(
      undoable(
        { severity: 'success', summary: `${membershipDoneText(change, m)}.`, life: 3000 },
        offer,
      ),
    );
    store.bumpData();
    if (change === 'add') emit('close');
  },
  onFailed: ({ op: { change, membership }, message }) =>
    store.reportError(
      `Windows cannot ${membershipChangeText(change, membership)} because:\n${message}`,
    ),
});

// A licensed group gives whoever joins it its licenses, so the list says which.
const licensed = useLicensedGroupsStore();
const licenseNames = (groupId: string) =>
  licensed
    .licensesOf(groupId)
    .map((l) => l.name)
    .join(', ');

onMounted(() => {
  void load(props.userId);
  void licensed.ensureLoaded();
});

const selected = ref<GroupSummary | null>(null);
const canOk = computed(
  () =>
    !!selected.value && existing(selected.value.id) !== 'direct' && ready.value && !adding.value,
);

function ok(): void {
  if (!canOk.value) return;
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
            <template v-if="licenseNames(g.id)"> (licenses: {{ licenseNames(g.id) }})</template>
          </span>
          <span style="color: var(--os-window-text-muted)">{{ g.description ?? '' }}</span>
        </div>
      </div>

      <div v-if="truncated && !searching" class="os-info" style="margin-top: 6px">
        Showing {{ results.length }} — refine your search.
      </div>
      <div v-if="loadError" class="os-error" style="margin-top: 10px">{{ loadError }}</div>
    </div>
  </WinDialog>
</template>
