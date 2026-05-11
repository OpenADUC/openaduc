<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';

type Severity = 'danger' | 'warn' | 'info';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    title: string;
    message?: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    severity?: Severity;
    busy?: boolean;
  }>(),
  {
    message: '',
    detail: '',
    severity: 'danger',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    busy: false,
  },
);

const emit = defineEmits<{
  'update:visible': [value: boolean];
  confirm: [];
  cancel: [];
}>();

function onCancel(): void {
  emit('update:visible', false);
  emit('cancel');
}

function onConfirm(): void {
  emit('confirm');
}

const ICONS: Record<Severity, string> = {
  danger: 'pi pi-exclamation-triangle',
  warn: 'pi pi-exclamation-circle',
  info: 'pi pi-info-circle',
};

const sev = computed<Severity>(() => props.severity ?? 'danger');
const iconClass = computed(() => ICONS[sev.value]);
const sevClass = computed(() => `sev-${sev.value}`);
const buttonSeverity = computed<'danger' | 'warn' | 'primary'>(() =>
  sev.value === 'danger' ? 'danger' : sev.value === 'warn' ? 'warn' : 'primary',
);
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
    <div class="confirm-body">
      <i :class="['confirm-icon', iconClass, sevClass]" />
      <div class="confirm-text">
        <p v-if="message" class="confirm-message">{{ message }}</p>
        <p v-if="detail" class="confirm-detail">{{ detail }}</p>
      </div>
    </div>
    <template #footer>
      <Button :label="cancelLabel" text severity="secondary" :disabled="busy" @click="onCancel" />
      <Button :label="confirmLabel" :severity="buttonSeverity" :loading="busy" @click="onConfirm" />
    </template>
  </Dialog>
</template>

<style scoped>
.confirm-body {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.confirm-icon {
  flex: 0 0 auto;
  font-size: 20px;
  margin-top: 2px;
}

.confirm-icon.sev-danger {
  color: var(--red);
}

.confirm-icon.sev-warn {
  color: var(--amber);
}

.confirm-icon.sev-info {
  color: var(--blue);
}

.confirm-text {
  min-width: 0;
}

.confirm-message {
  margin: 0 0 6px;
  font-size: 13.5px;
  color: var(--text);
  line-height: 1.45;
}

.confirm-detail {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}
</style>
