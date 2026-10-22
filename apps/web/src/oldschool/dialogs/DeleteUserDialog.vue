<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Are you sure you want to delete…" prompt, with the same
     guard rails as the modern dialog (useUserDeletion): only disabled,
     non-system accounts, the Recycle Bin state spelled out, and OK held
     until the logon name is typed. -->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import WinDialog from './WinDialog.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';
import { BLOCK_TEXT, useUserDeletion } from '../../design/composables/useUserDeletion.js';

const props = defineProps<{ windowId: number; id: string; label: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();
const {
  phase,
  loadError,
  preflight,
  typed,
  failures,
  eligible,
  blocked,
  confirmWord,
  confirmed,
  load,
  run,
} = useUserDeletion();

// The context menu runs step-up before opening this window, so the
// preflight (which binds as the operator) can go straight out.
onMounted(() => void load([props.id]));

const recycleText = computed(() => {
  const rb = preflight.value?.recycleBin;
  if (!rb)
    return 'Could not check whether the AD Recycle Bin is on. Assume this object cannot be fully restored.';
  return rb.recycleBinEnabled
    ? 'The AD Recycle Bin is on. The object can be restored with its attributes and group memberships.'
    : 'The AD Recycle Bin is off. This object cannot be restored from here; AD keeps only a tombstone without group memberships or most attributes.';
});

async function submit(): Promise<void> {
  const deleted = await run();
  if (deleted.includes(props.id)) {
    toast.add({
      severity: 'success',
      summary: 'Object deleted.',
      detail: `${props.label} has been deleted.`,
      life: 4000,
    });
    store.setSelection([]);
    store.bumpData();
    emit('close');
  }
}
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
    :can-ok="phase === 'review' && eligible.length === 1 && confirmed"
    @ok="submit"
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div style="display: flex; gap: 16px; align-items: flex-start; padding: 18px; font-size: 12px">
      <svg viewBox="0 0 40 40" width="40" height="40" style="flex: 0 0 40px">
        <path d="M20 3 L38 36 L2 36 Z" fill="#fff4ce" stroke="#b58500" stroke-width="1.5" />
        <text
          x="20"
          y="32"
          text-anchor="middle"
          font-family="Segoe UI"
          font-size="20"
          font-weight="700"
          fill="#7a5a00"
        >
          !
        </text>
      </svg>
      <div style="flex: 1; min-width: 0">
        <div v-if="phase === 'loading'">Checking the account…</div>
        <div v-else-if="phase === 'error'" class="os-error">{{ loadError }}</div>
        <div v-else-if="blocked.length > 0" class="os-error">
          {{ label }} can't be deleted: {{ BLOCK_TEXT[blocked[0]!.blockedReason!] }}
        </div>
        <template v-else-if="phase === 'review' || phase === 'running'">
          <div style="margin-bottom: 10px">
            Are you sure you want to delete the User named '{{ label }}'?
          </div>
          <div style="margin-bottom: 10px; color: var(--os-window-text-muted)">
            {{ recycleText }}
          </div>
          <label for="del-confirm" style="display: block; margin-bottom: 4px">
            Type <strong>{{ confirmWord }}</strong> to confirm:
          </label>
          <input
            id="del-confirm"
            v-model="typed"
            class="os-input"
            autocomplete="off"
            spellcheck="false"
            :disabled="phase === 'running'"
            @keyup.enter="confirmed && submit()"
          />
        </template>
        <div v-else-if="failures.length > 0" class="os-error">{{ failures[0]!.message }}</div>
      </div>
    </div>
  </WinDialog>
</template>
