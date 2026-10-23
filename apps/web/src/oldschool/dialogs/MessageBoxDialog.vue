<!-- SPDX-License-Identifier: BUSL-1.1
     Classic error message box: a red stop icon, the message, and OK. -->
<script setup lang="ts">
import WinDialog from './WinDialog.vue';

defineProps<{ windowId: number; title: string; message: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <WinDialog
    :window-id="windowId"
    :title="title"
    hide-apply
    hide-cancel
    :resizable="false"
    @ok="emit('close')"
    @cancel="emit('close')"
    @close="emit('close')"
    icon="properties"
  >
    <div role="alert" style="display: flex; gap: 16px; align-items: flex-start; padding: 20px">
      <div style="flex: 0 0 40px">
        <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
          <circle cx="20" cy="20" r="18" fill="#c42b1c" stroke="#8e1f14" stroke-width="1.5" />
          <path d="M13 13 L27 27 M27 13 L13 27" stroke="#fff" stroke-width="3.5" />
        </svg>
      </div>
      <div style="flex: 1; padding-top: 4px; font-size: 12px; white-space: pre-wrap">
        {{ message }}
      </div>
    </div>
  </WinDialog>
</template>
