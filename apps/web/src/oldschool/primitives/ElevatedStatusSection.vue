<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { useElevatedSession } from '../../design/composables/useElevatedSession.js';

const { active, summary, ending, end } = useElevatedSession();
</script>

<template>
  <div v-if="active" class="os-statusbar-section os-elevated">
    <span role="status">{{ summary }}</span>
    <button
      type="button"
      class="os-elevated-end"
      aria-label="End elevated session"
      :disabled="ending"
      @click="end"
    >
      End now
    </button>
  </div>
</template>

<style scoped>
.os-elevated {
  gap: 6px;
  white-space: nowrap;
}

.os-elevated-end {
  font: inherit;
  color: var(--os-window-text);
  background: transparent;
  border: 0;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
}

.os-elevated-end:disabled {
  cursor: progress;
  opacity: 0.6;
}
</style>
