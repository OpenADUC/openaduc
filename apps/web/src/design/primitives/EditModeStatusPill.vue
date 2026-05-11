<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { useThemeStore } from '../stores/useTheme.js';
import { useResponsive } from '../composables/useResponsive.js';

/**
 * EditModeStatusPill — small bottom-center readout that surfaces the live
 * edit-mode countdown without crowding the corner. Mirrors the FAB's
 * accent and urgency tones so the two read as one "armed" indicator;
 * the urgency *motion* (pulse) stays FAB-only to keep a single point of
 * attention. Pill never accepts clicks. Only rendered while elevated.
 */
const auth = useAuthStore();
const theme = useThemeStore();
const { isMobile } = useResponsive();

const formattedCountdown = computed(() => {
  const s = auth.remainingSeconds;
  if (s === null) return '';
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
});

// Urgency tone in lockstep with the FAB. Same thresholds.
const tone = computed<'normal' | 'warn' | 'critical'>(() => {
  const s = auth.remainingSeconds;
  if (s === null) return 'normal';
  if (s <= 30) return 'critical';
  if (s <= 60) return 'warn';
  return 'normal';
});

// Center the pill on the *main content panel* rather than the raw viewport.
// On desktop the sidebar consumes the left edge, so a 50% viewport centroid
// reads visually off-center. Shift right by half the sidebar width (which
// itself depends on whether the sidebar is collapsed). On mobile the sidebar
// is off-canvas, so plain viewport centering is correct.
const pillLeft = computed(() => {
  if (isMobile.value) return '50%';
  const sb = theme.sidebarCollapsed ? 'var(--sb-w-collapsed)' : 'var(--sb-w)';
  return `calc(50% + ${sb} / 2)`;
});
</script>

<template>
  <Transition name="pill-fade">
    <div
      v-if="auth.editMode"
      class="status-pill"
      :class="`tone-${tone}`"
      role="status"
      aria-live="polite"
      :style="{ left: pillLeft }"
    >
      <i class="pi pi-pencil" aria-hidden="true" />
      <span class="label">Editing</span>
      <span class="countdown mono">{{ formattedCountdown }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.status-pill {
  position: fixed;
  left: 50%;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 12px;
  border-radius: 14px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--bg);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  pointer-events: none;
  z-index: 40;
}

.status-pill .label {
  letter-spacing: 0.01em;
}

/* Same color recipes as the FAB — the two surfaces shift in lockstep. */
.status-pill.tone-warn {
  background: #f59e0b;
  border-color: color-mix(in oklab, #f59e0b 70%, black);
  color: #1a1a1a;
}

.status-pill.tone-critical {
  background: #ef4444;
  border-color: color-mix(in oklab, #ef4444 70%, black);
  color: #fff;
}

.status-pill .countdown {
  font-size: 11.5px;
  color: color-mix(in oklab, currentColor 75%, transparent);
  font-variant-numeric: tabular-nums;
  padding-left: 4px;
  border-left: 1px solid color-mix(in oklab, currentColor 35%, transparent);
}

.pill-fade-enter-active,
.pill-fade-leave-active {
  transition:
    opacity 150ms ease,
    transform 150ms ease;
}

.pill-fade-enter-from,
.pill-fade-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}

@media (prefers-reduced-motion: reduce) {
  .pill-fade-enter-active,
  .pill-fade-leave-active {
    transition: none;
  }
}

@media (max-width: 767.98px) {
  .status-pill {
    font-size: 12px;
    height: 26px;
    padding: 0 10px;
  }
}
</style>
