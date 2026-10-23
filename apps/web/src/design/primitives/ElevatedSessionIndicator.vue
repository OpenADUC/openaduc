<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { ref } from 'vue';
import Popover from 'primevue/popover';
import { useElevatedSession } from '../composables/useElevatedSession.js';

// Compact (collapsed sidebar, and so phones) opens a popover rather than
// ending the session on one tap.
defineProps<{ compact?: boolean }>();

const { active, until, summary, ending, end } = useElevatedSession();
const popover = ref<InstanceType<typeof Popover> | null>(null);
</script>

<template>
  <div v-if="active" class="elevated-indicator" :class="{ compact }">
    <template v-if="compact">
      <span role="status" class="ei-hidden">{{ summary }}</span>
      <button
        v-tooltip.right="summary"
        type="button"
        class="ei-icon-btn"
        aria-label="Writes unlocked"
        aria-haspopup="dialog"
        @click="popover?.toggle($event)"
      >
        <i class="pi pi-lock-open" aria-hidden="true" />
      </button>
      <Popover ref="popover">
        <div class="elevated-indicator">
          <span class="ei-text">
            <span class="ei-label">Writes unlocked</span>
            <span v-if="until" class="ei-sub">{{ until }}</span>
          </span>
          <button
            type="button"
            class="ei-end"
            aria-label="End elevated session"
            :disabled="ending"
            @click="end"
          >
            End now
          </button>
        </div>
      </Popover>
    </template>
    <template v-else>
      <i class="pi pi-lock-open ei-icon" aria-hidden="true" />
      <span class="ei-text" role="status">
        <span class="ei-label">Writes unlocked</span>
        <span v-if="until" class="ei-sub">{{ until }}</span>
      </span>
      <button
        type="button"
        class="ei-end"
        aria-label="End elevated session"
        :disabled="ending"
        @click="end"
      >
        End now
      </button>
    </template>
  </div>
</template>

<style scoped>
.elevated-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  color: var(--text-2);
  font-size: 12px;
  min-width: 0;
}

.ei-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.elevated-indicator.compact {
  justify-content: center;
  padding: 0;
}

.ei-icon {
  color: var(--accent);
  font-size: 13px;
  flex: 0 0 auto;
}

.ei-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  min-width: 0;
  flex: 1;
}

.ei-label {
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ei-sub {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ei-end,
.ei-icon-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-2);
  cursor: pointer;
  flex: 0 0 auto;
}

.ei-end {
  font-size: 11.5px;
  padding: 2px 8px;
}

.ei-icon-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  color: var(--accent);
  font-size: 13px;
}

.ei-end:hover:not(:disabled),
.ei-icon-btn:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.ei-end:focus-visible,
.ei-icon-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.ei-end:disabled,
.ei-icon-btn:disabled {
  cursor: progress;
  opacity: 0.7;
}
</style>
