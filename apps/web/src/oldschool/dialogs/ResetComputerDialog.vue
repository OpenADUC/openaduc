<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Are you sure you want to reset this computer account?"
     prompt, rendering the shared workflow (useComputerReset). Like ADUC
     it closes on Yes; the outcome comes as a toast or a message box. -->
<script setup lang="ts">
import { onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import WinDialog from './WinDialog.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useComputerReset } from '../../design/composables/useComputerReset.js';

const props = defineProps<{ windowId: number; id: string; label: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();
// Runs after this prompt has closed.
const { ask, confirm, cancel } = useComputerReset({
  onReset: () => {
    toast.add({
      severity: 'success',
      summary: `Account ${props.label} was successfully reset.`,
      life: 4000,
    });
    store.bumpData();
  },
  onFailed: ({ message }) =>
    store.reportError(`Windows cannot reset the account of ${props.label} because:\n${message}`),
});

onMounted(() => ask({ id: props.id }));

function yes(): void {
  confirm();
  emit('close');
}

function no(): void {
  cancel();
  emit('close');
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
    @ok="yes"
    @cancel="no"
    @close="no"
  >
    <div style="padding: 18px; font-size: 12px">
      <div style="margin-bottom: 10px">Are you sure you want to reset this computer account?</div>
      <div style="color: var(--os-window-text-muted)">
        {{ label }} can't sign in to the domain until it rejoins under the same name.
      </div>
    </div>
  </WinDialog>
</template>
