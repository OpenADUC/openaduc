<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Are you sure you want to delete…" prompt for a group,
     rendering the shared workflow (useGroupDeletion): it says how many
     members the group has and which groups it's in, refuses built-in and
     protected groups, and holds Yes until the pre-Windows 2000 name is
     typed. -->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import WinDialog from './WinDialog.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useGroupDeletion } from '../../design/composables/useGroupDeletion.js';

const props = defineProps<{ windowId: number; id: string; label: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();
const {
  phase,
  loadError,
  preflight,
  typed,
  blockedText,
  confirmWord,
  confirmed,
  deleting,
  error,
  load,
  remove,
} = useGroupDeletion({
  onDeleted: () => {
    toast.add({
      severity: 'success',
      summary: 'Object deleted.',
      detail: `${props.label} has been deleted.`,
      life: 4000,
    });
    store.setSelection([]);
    store.bumpData();
    emit('close');
  },
});

onMounted(() => void load(props.id));

const holds = computed(() => {
  const p = preflight.value;
  if (!p) return '';
  const members = p.memberCount === 1 ? '1 member' : `${p.memberCount} members`;
  const parents = p.memberOf.map((g) => g.name ?? g.distinguishedName);
  return parents.length === 0
    ? `It has ${members} and is not a member of any group.`
    : `It has ${members} and is a member of: ${parents.join(', ')}.`;
});
</script>

<template>
  <WinDialog
    :window-id="windowId"
    title="Active Directory Domain Services"
    hide-apply
    ok-label="Yes"
    cancel-label="No"
    confirm-tone="destructive"
    :resizable="false"
    :can-ok="confirmed && !deleting"
    @ok="remove"
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div style="padding: 18px; font-size: 12px">
      <div v-if="phase === 'loading'">Checking the group…</div>
      <div v-else-if="phase === 'error'" class="os-error">{{ loadError }}</div>
      <div v-else-if="blockedText" class="os-error">
        {{ label }} can't be deleted: {{ blockedText }}
      </div>
      <template v-else>
        <div style="margin-bottom: 10px">
          Are you sure you want to delete the Group named '{{ label }}'?
        </div>
        <div style="margin-bottom: 10px; color: var(--os-window-text-muted)">{{ holds }}</div>
        <label for="del-group-confirm" style="display: block; margin-bottom: 4px">
          Type <strong>{{ confirmWord }}</strong> to confirm:
        </label>
        <input
          id="del-group-confirm"
          v-model="typed"
          class="os-input"
          autocomplete="off"
          spellcheck="false"
          :disabled="deleting"
          @keyup.enter="remove"
        />
        <div v-if="error" class="os-error" style="margin-top: 8px">{{ error }}</div>
      </template>
    </div>
  </WinDialog>
</template>
