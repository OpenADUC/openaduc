<!-- SPDX-License-Identifier: BUSL-1.1
     Classic Win32-style modeless dialog. Floats at the position
     tracked by useOldSchool().windows[]: draggable by the titlebar,
     resizable by the SE corner, click-to-focus brings it on top of
     any sibling windows. No darkening backdrop — depth comes from a
     drop shadow and a 2px border, the way real MMC dialogs look on
     a desktop.

     Props
       windowId   — stable id under which the position is tracked.
       title      — text in the title bar.
       icon       — optional WinIcon name to render at the left.
       canApply   — enables / disables the Apply button.
       canOk      — enables / disables the OK button (default true).
       okLabel / cancelLabel / applyLabel — button text overrides.
       hideOk / hideCancel / hideApply — hide any of the footer buttons.
       confirmTone — 'destructive' tints the title bar red.
       resizable  — show the SE-corner resize handle (default true).
       minWidth / minHeight — resize floor (defaults 320 × 220).
     Events
       ok, cancel, apply, close
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import WinIcon from '../primitives/WinIcon.vue';
import { useOldSchool } from '../stores/useOldSchool.js';

const props = withDefaults(
  defineProps<{
    windowId: number;
    title: string;
    icon?: string | undefined;
    canApply?: boolean | undefined;
    canOk?: boolean | undefined;
    okLabel?: string | undefined;
    cancelLabel?: string | undefined;
    applyLabel?: string | undefined;
    hideApply?: boolean | undefined;
    hideOk?: boolean | undefined;
    hideCancel?: boolean | undefined;
    confirmTone?: 'normal' | 'destructive' | undefined;
    resizable?: boolean | undefined;
    minWidth?: number | undefined;
    minHeight?: number | undefined;
  }>(),
  {
    icon: 'properties',
    canApply: false,
    canOk: true,
    okLabel: 'OK',
    cancelLabel: 'Cancel',
    applyLabel: 'Apply',
    hideApply: false,
    hideOk: false,
    hideCancel: false,
    confirmTone: 'normal',
    resizable: true,
    minWidth: 320,
    minHeight: 200,
  },
);

const emit = defineEmits<{
  (e: 'ok'): void;
  (e: 'cancel'): void;
  (e: 'apply'): void;
  (e: 'close'): void;
}>();

const store = useOldSchool();

// The window record lives in the store; the dialog just renders
// whatever the store says. If the record disappears (race during
// close), fall back to safe defaults so the template doesn't error.
const win = computed(() => store.windows.find((w) => w.id === props.windowId) ?? null);

const style = computed(() => {
  const w = win.value;
  if (!w) return { display: 'none' };
  return {
    left: `${w.x}px`,
    top: `${w.y}px`,
    width: `${w.width}px`,
    height: `${w.height}px`,
    zIndex: w.z,
  };
});

function close(): void {
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

// --- Focus -----------------------------------------------------------
function focus(): void {
  store.focusWindow(props.windowId);
}

// --- Drag (titlebar) -------------------------------------------------
function startDrag(e: MouseEvent): void {
  if (!win.value) return;
  // Ignore clicks on the title bar buttons — they have their own handlers.
  const target = e.target as HTMLElement;
  if (target.closest('button')) return;
  e.preventDefault();
  focus();
  const startX = e.clientX;
  const startY = e.clientY;
  const startLeft = win.value.x;
  const startTop = win.value.y;
  const onMove = (ev: MouseEvent): void => {
    if (!win.value) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Clamp so at least 80px of the titlebar always remains
    // reachable, and the bottom-right corner can't escape the
    // viewport (so it can be picked up again).
    const x = Math.max(
      8 - win.value.width + 120,
      Math.min(vw - 80, startLeft + ev.clientX - startX),
    );
    const y = Math.max(8, Math.min(vh - 40, startTop + ev.clientY - startY));
    store.moveWindow(props.windowId, x, y);
  };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// --- Resize (SE corner) ----------------------------------------------
function startResize(e: MouseEvent): void {
  if (!win.value) return;
  e.preventDefault();
  e.stopPropagation();
  focus();
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = win.value.width;
  const startH = win.value.height;
  const onMove = (ev: MouseEvent): void => {
    if (!win.value) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxW = Math.max(props.minWidth, vw - win.value.x - 8);
    const maxH = Math.max(props.minHeight, vh - win.value.y - 8);
    const w = Math.min(maxW, Math.max(props.minWidth, startW + ev.clientX - startX));
    const h = Math.min(maxH, Math.max(props.minHeight, startH + ev.clientY - startY));
    store.resizeWindow(props.windowId, w, h);
  };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// --- Keyboard --------------------------------------------------------
//
// Esc closes when this window is the topmost open window. With multiple
// floating dialogs the Esc handler shouldn't fire for every instance —
// only the focused one.
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const w = win.value;
  if (!w) return;
  const top = store.windows.reduce(
    (best, cur) => (best == null || cur.z > best.z ? cur : best),
    null as null | { z: number; id: number },
  );
  if (top?.id !== w.id) return;
  e.stopPropagation();
  onCancel();
}
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="win"
      class="os-dialog floating"
      :class="{ destructive: confirmTone === 'destructive' }"
      :style="style"
      role="dialog"
      aria-modal="false"
      @mousedown="focus"
    >
      <div class="os-dialog-titlebar" @mousedown="startDrag">
        <WinIcon class="icon" :name="icon as any" />
        <div class="title">{{ title }}</div>
        <button class="help-btn" type="button" title="Help" @click="close">
          <WinIcon name="help" :size="14" />
        </button>
        <button class="close-btn" type="button" title="Close" aria-label="Close" @click="onCancel">
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <!-- Tab strip slot. Sits between the titlebar and the scroll
           body so the tab labels never scroll out of view and the
           dialog frame stays stable as the user clicks across tabs. -->
      <slot name="tabs" />

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

      <div v-if="resizable" class="os-resize-handle" @mousedown="startResize">
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path
            d="M11 1 L1 11 M11 5 L5 11 M11 9 L9 11"
            fill="none"
            stroke="currentColor"
            stroke-width="1"
          />
        </svg>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.os-dialog.floating {
  position: fixed;
  /* width / height / top / left / z-index come from inline style */
}
.os-dialog-titlebar {
  cursor: move;
}
.os-dialog-titlebar.destructive,
.os-dialog.destructive .os-dialog-titlebar {
  background: linear-gradient(to bottom, #a82323, #7a1414);
}
.os-resize-handle {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  color: var(--os-window-border-darker);
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 1px;
  user-select: none;
}
</style>
