<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useToast } from 'primevue/usetoast';
import { useAuthStore } from '../../stores/auth.js';

/**
 * EditModeFab — the bottom-right floating affordance for entering and
 * leaving edit mode. Replaces the topbar EditModeToggle chip.
 *
 * State branching by actor capability:
 *   - No actor (logged out): not rendered.
 *   - Actor without write capability: disabled FAB with a lock icon and a
 *     tooltip explaining why. No interaction.
 *   - Write-capable, not elevated: outlined pencil FAB; click opens the
 *     StepUpDialog (mounted in AppShell) by flipping `auth.stepUpRequested`.
 *   - Write-capable, elevated: solid accent pencil FAB with urgency tones
 *     (warn at <=60s, critical pulsing at <=30s) driven by
 *     `auth.remainingSeconds`. Click revokes step-up to end edit mode.
 *
 * The accompanying countdown lives in EditModeStatusPill — this component
 * intentionally has no on-screen text so the FAB stays a clean circular
 * affordance.
 */
const auth = useAuthStore();
const toast = useToast();
const revoking = ref(false);

const countdownTone = computed<'normal' | 'warn' | 'critical'>(() => {
  const s = auth.remainingSeconds;
  if (s === null) return 'normal';
  if (s <= 30) return 'critical';
  if (s <= 60) return 'warn';
  return 'normal';
});

// Track when edit mode flips off due to expiry (vs. user click) so we can
// surface a small "edit mode ended" toast. Same logic that used to live in
// EditModeToggle: when editMode goes true -> false and we weren't actively
// revoking and there's no step-up dialog in flight, the cause was the TTL
// clock. The mid-action re-auth case (stepUpRequested true) must NOT toast
// — the dialog itself is the affordance.
let lastEditMode = auth.editMode;
watch(
  () => auth.editMode,
  (now) => {
    if (lastEditMode && !now && !revoking.value && !auth.stepUpRequested) {
      toast.add({
        severity: 'info',
        summary: 'Edit mode ended',
        detail: 'Your editing session timed out. Re-enable to keep editing.',
        life: 4000,
      });
    }
    lastEditMode = now;
  },
);

async function onClick(): Promise<void> {
  if (auth.editMode) {
    revoking.value = true;
    try {
      await auth.disableEditMode();
    } finally {
      revoking.value = false;
    }
  } else {
    // The dialog itself is mounted in AppShell.vue and is controlled by
    // the store flag; this button just requests it. That single source
    // of truth is what lets the API client auto-open the same dialog
    // when a privileged action fails because the cached step-up
    // password is gone (process restart, AD password rotation, etc.).
    auth.requestStepUp();
  }
}
</script>

<template>
  <!-- No actor: render nothing. Login/setup screens use the bare layout
       anyway, but guarding here keeps this primitive usable in future
       contexts where the shell is mounted before sign-in completes. -->
  <template v-if="auth.actor">
    <!-- Disabled FAB for accounts that have no write capability at all
         (recovery sessions, accounts without the right group memberships).
         The tooltip explains *why* — same signal the old "View only" pill
         carried, just relocated. -->
    <button
      v-if="!auth.canEverWrite"
      type="button"
      class="edit-fab disabled"
      disabled
      title="Editing isn't available for this account. Sign in with an AD account that has the right group memberships."
      aria-label="Editing unavailable"
    >
      <i class="pi pi-lock" aria-hidden="true" />
    </button>

    <!-- The real toggle: outlined pencil when off, solid accent when on,
         tone-shifted when running out of time. -->
    <button
      v-else
      type="button"
      class="edit-fab"
      :class="{ on: auth.editMode, [`tone-${countdownTone}`]: auth.editMode }"
      :aria-pressed="auth.editMode"
      :aria-label="auth.editMode ? 'End editing' : 'Start editing'"
      :disabled="revoking"
      :title="auth.editMode ? 'Click to end editing' : 'Click to start editing'"
      @click="onClick"
    >
      <!-- PrimeIcons only ships an outlined pencil. When editing, swap to
           an inline filled SVG so the glyph itself reads as "active" — not
           just the FAB's background. -->
      <svg
        v-if="auth.editMode"
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M3 17.46V21h3.54L17.81 9.74l-3.54-3.54L3 17.46zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
        />
      </svg>
      <i v-else class="pi pi-pencil" aria-hidden="true" />
    </button>
  </template>
</template>

<style scoped>
.edit-fab {
  position: fixed;
  right: calc(24px + env(safe-area-inset-right, 0px));
  bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 20px;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease,
    transform 120ms ease;
  z-index: 40;
}

.edit-fab:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-3);
  transform: scale(1.04);
}

.edit-fab:active:not(:disabled) {
  transform: scale(0.98);
}

.edit-fab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.edit-fab.disabled {
  cursor: not-allowed;
  opacity: 0.55;
  background: var(--surface-2);
  border-color: var(--border);
  color: var(--text-3);
  box-shadow: none;
}

.edit-fab:disabled:not(.disabled) {
  cursor: progress;
  opacity: 0.7;
}

/* Editing — solid accent. Same color recipe as the old toggle's "on" state
   so the urgency vocabulary matches anything else accent-tinted in the app. */
.edit-fab.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}

.edit-fab.on:hover:not(:disabled) {
  background: color-mix(in oklab, var(--accent) 88%, white);
}

.edit-fab.on.tone-warn {
  background: #f59e0b;
  border-color: color-mix(in oklab, #f59e0b 70%, black);
  color: #1a1a1a;
}

.edit-fab.on.tone-critical {
  background: #ef4444;
  border-color: color-mix(in oklab, #ef4444 70%, black);
  color: #fff;
  animation: edit-fab-pulse 1s ease-in-out infinite;
}

@keyframes edit-fab-pulse {
  0%,
  100% {
    box-shadow:
      0 6px 18px rgba(0, 0, 0, 0.18),
      0 0 0 0 color-mix(in oklab, #ef4444 50%, transparent);
  }
  50% {
    box-shadow:
      0 6px 18px rgba(0, 0, 0, 0.18),
      0 0 0 8px color-mix(in oklab, #ef4444 0%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .edit-fab,
  .edit-fab:hover:not(:disabled),
  .edit-fab:active:not(:disabled) {
    transition: none;
    transform: none;
  }
  .edit-fab.on.tone-critical {
    animation: none;
  }
}

@media (max-width: 767.98px) {
  .edit-fab {
    width: 40px;
    height: 40px;
    right: calc(16px + env(safe-area-inset-right, 0px));
    bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    font-size: 18px;
  }
}
</style>
