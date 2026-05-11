<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { ref } from 'vue';
import WinDialog from './WinDialog.vue';

const props = withDefaults(
  defineProps<{
    title: string;
    message: string;
    okLabel?: string | undefined;
    cancelLabel?: string | undefined;
    destructive?: boolean | undefined;
    onOk: () => void | Promise<void>;
  }>(),
  { okLabel: 'OK', cancelLabel: 'Cancel', destructive: false },
);

const emit = defineEmits<{ (e: 'close'): void }>();
const visible = ref(true);

async function handleOk(): Promise<void> {
  try {
    await props.onOk();
  } finally {
    visible.value = false;
    emit('close');
  }
}
</script>

<template>
  <WinDialog
    :visible="visible"
    :title="title"
    :width="420"
    :ok-label="okLabel"
    :cancel-label="cancelLabel"
    hide-apply
    :confirm-tone="destructive ? 'destructive' : 'normal'"
    @ok="handleOk"
    @cancel="emit('close')"
    @update:visible="(v) => !v && emit('close')"
    icon="properties"
  >
    <div style="display: flex; gap: 16px; align-items: flex-start; padding: 20px">
      <div style="flex: 0 0 40px">
        <svg viewBox="0 0 40 40" width="40" height="40">
          <circle
            cx="20"
            cy="20"
            r="18"
            :fill="destructive ? '#fde2e2' : '#deecf9'"
            :stroke="destructive ? '#c00' : '#1d4f8c'"
            stroke-width="1.5"
          />
          <text
            x="20"
            y="28"
            text-anchor="middle"
            font-family="Segoe UI"
            font-size="22"
            font-weight="700"
            :fill="destructive ? '#c00' : '#1d4f8c'"
          >
            {{ destructive ? '!' : 'i' }}
          </text>
        </svg>
      </div>
      <div style="flex: 1; padding-top: 4px; font-size: 12px; white-space: pre-wrap">
        {{ message }}
      </div>
    </div>
  </WinDialog>
</template>
