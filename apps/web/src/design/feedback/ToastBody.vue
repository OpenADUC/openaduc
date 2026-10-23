<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { UndoableToastMessage } from './undoToast.js';

// One toast's content. An Undo toast is sticky as far as PrimeVue knows;
// this times it instead, pausing while it's hovered or has keyboard focus,
// so it can't vanish under the operator on the way to Undo.
const props = defineProps<{ message: UndoableToastMessage }>();

const toast = useToast();
const root = ref<HTMLElement | null>(null);

const ICONS: Record<string, string> = {
  success: 'pi-check',
  info: 'pi-info-circle',
  warn: 'pi-exclamation-triangle',
  error: 'pi-times-circle',
};

let remaining = props.message.undoLife ?? 0;
let startedAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let hovered = false;
let focused = false;
let box: HTMLElement | null = null;

function resume(): void {
  if (timer || hovered || focused) return;
  startedAt = Date.now();
  timer = setTimeout(() => toast.remove(props.message), remaining);
}

function pause(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = undefined;
  remaining -= Date.now() - startedAt;
}

const listeners: Record<string, (e: Event) => void> = {
  mouseenter: () => ((hovered = true), pause()),
  mouseleave: () => ((hovered = false), resume()),
  focusin: () => ((focused = true), pause()),
  focusout: (e) => {
    if (box?.contains((e as FocusEvent).relatedTarget as Node | null)) return;
    focused = false;
    resume();
  },
};

onMounted(() => {
  if (!props.message.undo) return;
  box = root.value?.closest<HTMLElement>('.p-toast-message') ?? root.value;
  for (const [type, fn] of Object.entries(listeners)) box?.addEventListener(type, fn);
  resume();
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  for (const [type, fn] of Object.entries(listeners)) box?.removeEventListener(type, fn);
});

function undo(): void {
  props.message.undo?.();
  toast.remove(props.message);
}
</script>

<template>
  <i
    :class="['p-toast-message-icon', 'pi', ICONS[message.severity ?? 'info'] ?? ICONS.info]"
    aria-hidden="true"
  />
  <div ref="root" class="p-toast-message-text">
    <span class="p-toast-summary">{{ message.summary }}</span>
    <div v-if="message.detail" class="p-toast-detail">{{ message.detail }}</div>
    <Button
      v-if="message.undo"
      label="Undo"
      icon="pi pi-undo"
      size="small"
      text
      class="toast-undo"
      @click="undo"
    />
  </div>
</template>

<style scoped>
.toast-undo {
  margin-top: 6px;
  margin-left: -8px;
}
</style>
