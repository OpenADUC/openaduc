<!-- SPDX-License-Identifier: BUSL-1.1
     Classic right-click context menu. Items are passed in as a tree;
     'separator' yields a horizontal rule. We don't implement
     submenus — ADUC's "All Tasks" submenu is flattened into the main
     list with an italic header to keep this small. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import WinIcon from './WinIcon.vue';

export interface CtxItem {
  kind?: 'item' | 'separator' | 'header' | undefined;
  label?: string | undefined;
  icon?: string | undefined;
  disabled?: boolean | undefined;
  bold?: boolean | undefined;
  accel?: string | undefined;
  onSelect?: (() => void) | undefined;
}

const props = defineProps<{
  x: number;
  y: number;
  items: CtxItem[];
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const root = ref<HTMLElement | null>(null);
const pos = ref({ left: props.x, top: props.y });

function reposition(): void {
  // Keep the menu inside the viewport — flip left/up when we'd overflow.
  if (!root.value) return;
  const rect = root.value.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = props.x;
  let top = props.y;
  if (left + rect.width > vw - 4) left = Math.max(4, vw - rect.width - 4);
  if (top + rect.height > vh - 4) top = Math.max(4, vh - rect.height - 4);
  pos.value = { left, top };
}

function onDoc(e: MouseEvent): void {
  if (!root.value) return;
  if (!root.value.contains(e.target as Node)) emit('close');
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
function onItem(it: CtxItem): void {
  if (it.disabled || it.kind === 'separator' || it.kind === 'header') return;
  emit('close');
  // Defer so the close transition (and listener teardown) finish first.
  setTimeout(() => it.onSelect?.(), 0);
}

onMounted(() => {
  reposition();
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', reposition);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDoc, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', reposition);
});

watch(
  () => [props.x, props.y],
  () => reposition(),
);

const style = computed(() => ({ left: `${pos.value.left}px`, top: `${pos.value.top}px` }));
</script>

<template>
  <div ref="root" class="os-ctx" :style="style" role="menu">
    <template v-for="(it, i) in items" :key="i">
      <div v-if="it.kind === 'separator'" class="os-menu-separator" />
      <div
        v-else-if="it.kind === 'header'"
        class="os-menu-row"
        style="font-style: italic; color: var(--os-window-text-muted); pointer-events: none"
      >
        {{ it.label }}
      </div>
      <div
        v-else
        class="os-menu-row"
        :class="{ disabled: it.disabled }"
        :style="it.bold ? { fontWeight: 700 } : {}"
        role="menuitem"
        @click="onItem(it)"
      >
        <span class="os-menu-icon">
          <WinIcon v-if="it.icon" :name="it.icon as any" :size="14" />
        </span>
        <span>{{ it.label }}</span>
        <span v-if="it.accel" class="os-menu-accel">{{ it.accel }}</span>
      </div>
    </template>
  </div>
</template>
