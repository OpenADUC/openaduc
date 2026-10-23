<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import Toast from 'primevue/toast';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { UndoableToastMessage } from './undoToast.js';

// PrimeVue's Toast, plus an Undo button on messages built with `undoable`.
// Attributes such as `position` pass through to the Toast.

const toast = useToast();

const ICONS: Record<string, string> = {
  success: 'pi-check',
  info: 'pi-info-circle',
  warn: 'pi-exclamation-triangle',
  error: 'pi-times-circle',
};

function undo(message: UndoableToastMessage): void {
  toast.remove(message);
  message.undo?.();
}
</script>

<template>
  <Toast>
    <template #message="{ message }">
      <i
        :class="['p-toast-message-icon', 'pi', ICONS[message.severity ?? 'info'] ?? ICONS.info]"
        aria-hidden="true"
      />
      <div class="p-toast-message-text">
        <span class="p-toast-summary">{{ message.summary }}</span>
        <div v-if="message.detail" class="p-toast-detail">{{ message.detail }}</div>
        <Button
          v-if="(message as UndoableToastMessage).undo"
          label="Undo"
          icon="pi pi-undo"
          size="small"
          text
          class="toast-undo"
          @click="undo(message)"
        />
      </div>
    </template>
  </Toast>
</template>

<style scoped>
.toast-undo {
  margin-top: 6px;
  margin-left: -8px;
}
</style>
