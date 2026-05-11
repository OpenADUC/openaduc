<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Password from 'primevue/password';

const props = defineProps<{
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  confirm: [password: string];
  cancel: [];
}>();

const password = ref('');

watch(
  () => props.visible,
  (open) => {
    if (open) password.value = '';
  },
);

function onConfirm(): void {
  if (!password.value) return;
  emit('confirm', password.value);
}

function onCancel(): void {
  emit('update:visible', false);
  emit('cancel');
}
</script>

<template>
  <Dialog
    :visible="visible"
    @update:visible="(v) => emit('update:visible', v)"
    modal
    :header="title"
    :style="{ width: '26rem' }"
    :closable="!busy"
  >
    <p v-if="message" class="dialog-prose primary">{{ message }}</p>
    <p class="dialog-prose secondary">
      Confirm with your AD password. The server will bind as you to perform this action.
    </p>
    <Password
      v-model="password"
      :feedback="false"
      toggle-mask
      input-class="w-full"
      class="w-full"
      :disabled="busy"
      autocomplete="current-password"
      @keyup.enter="onConfirm"
    />
    <template #footer>
      <Button label="Cancel" text severity="secondary" :disabled="busy" @click="onCancel" />
      <Button :label="confirmLabel ?? 'Confirm'" :loading="busy" @click="onConfirm" />
    </template>
  </Dialog>
</template>

<style scoped>
.dialog-prose {
  font-size: 13px;
  margin: 0 0 12px;
}

.dialog-prose.primary {
  color: var(--text);
}

.dialog-prose.secondary {
  color: var(--text-3);
  font-size: 12px;
}

:deep(.p-password) {
  display: block;
  width: 100%;
}

:deep(.p-password .p-password-input) {
  width: 100%;
}
</style>
