<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { ref } from 'vue';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';

defineEmits<{ (e: 'close'): void }>();
const visible = ref(true);
</script>

<template>
  <WinDialog
    :visible="visible"
    title="About"
    icon="help"
    :width="440"
    hide-apply
    hide-cancel
    ok-label="OK"
    @ok="$emit('close')"
    @update:visible="(v) => !v && $emit('close')"
  >
    <div style="padding: 18px 20px; display: flex; gap: 16px; align-items: flex-start">
      <WinIcon name="aduc" :size="48" />
      <div style="font-size: 12px; line-height: 1.5">
        <div style="font-weight: 700; font-size: 13px; margin-bottom: 6px">
          Active Directory Users and Computers
        </div>
        <div>OpenADUC — Old School edition</div>
        <div style="color: var(--os-window-text-muted); margin-top: 6px">
          A loving recreation of the classic MMC console, riding on top of the modern OpenADUC web
          stack.
        </div>
      </div>
    </div>
  </WinDialog>
</template>
