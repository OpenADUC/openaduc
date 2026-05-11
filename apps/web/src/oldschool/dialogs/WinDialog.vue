<!-- SPDX-License-Identifier: BUSL-1.1
     Classic Win32-style modal dialog frame.

     Slots:
       default — body content
       footer — overrides the default OK/Cancel/Apply row
     Props:
       visible    — v-modeled `update:visible`
       title      — string shown in the dialog title bar
       icon       — WinIcon name to render in the title bar (optional)
       width      — fixed pixel width (default 480)
       canApply   — disables/enables the Apply button
       okLabel    — label override (default 'OK')
       cancelLabel— label override (default 'Cancel')
       hideApply  — when true, no Apply button
       hideOk     — when true, no OK button
       confirmTone— when 'destructive' the title bar uses the red warning paint
     Events:
       ok, cancel, apply, close
-->
<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue';
import WinIcon from '../primitives/WinIcon.vue';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    title: string;
    icon?: string | undefined;
    width?: number | undefined;
    canApply?: boolean | undefined;
    canOk?: boolean | undefined;
    okLabel?: string | undefined;
    cancelLabel?: string | undefined;
    applyLabel?: string | undefined;
    hideApply?: boolean | undefined;
    hideOk?: boolean | undefined;
    hideCancel?: boolean | undefined;
    confirmTone?: 'normal' | 'destructive' | undefined;
  }>(),
  {
    icon: 'properties',
    width: 480,
    canApply: false,
    canOk: true,
    okLabel: 'OK',
    cancelLabel: 'Cancel',
    applyLabel: 'Apply',
    hideApply: false,
    hideOk: false,
    hideCancel: false,
    confirmTone: 'normal',
  },
);

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void;
  (e: 'ok'): void;
  (e: 'cancel'): void;
  (e: 'apply'): void;
  (e: 'close'): void;
}>();

function close(): void {
  emit('update:visible', false);
  emit('close');
}
function onCancel(): void {
  emit('cancel');
  close();
}
function onOk(): void {
  emit('ok');
}
function onApply(): void {
  emit('apply');
}

function onKey(e: KeyboardEvent): void {
  if (!props.visible) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    onCancel();
  }
}
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));

// Lock body scroll while open so the dialog feels modal even though it
// renders inline (no Teleport — WinDialog instances live inside the MMC,
// which already covers the viewport).
watch(
  () => props.visible,
  (v) => {
    if (typeof document === 'undefined') return;
    if (v) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
  },
);
onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="os-dialog-backdrop" @mousedown.self="onCancel">
      <div class="os-dialog" :style="{ width: `${width}px` }" role="dialog" aria-modal="true">
        <div class="os-dialog-titlebar" :class="{ destructive: confirmTone === 'destructive' }">
          <WinIcon class="icon" :name="icon as any" />
          <div class="title">{{ title }}</div>
          <button class="help-btn" type="button" title="Help" @click="$emit('close')">
            <WinIcon name="help" :size="14" />
          </button>
          <button
            class="close-btn"
            type="button"
            title="Close"
            aria-label="Close"
            @click="onCancel"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div class="os-dialog-body">
          <slot />
        </div>

        <slot name="footer">
          <div class="os-dialog-footer">
            <button
              v-if="!hideOk"
              type="button"
              class="os-btn primary"
              :disabled="!canOk"
              @click="onOk"
            >
              {{ okLabel }}
            </button>
            <button v-if="!hideCancel" type="button" class="os-btn" @click="onCancel">
              {{ cancelLabel }}
            </button>
            <button
              v-if="!hideApply"
              type="button"
              class="os-btn"
              :disabled="!canApply"
              @click="onApply"
            >
              {{ applyLabel }}
            </button>
          </div>
        </slot>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.os-dialog-titlebar.destructive {
  background: linear-gradient(to bottom, #a82323, #7a1414);
}
</style>
