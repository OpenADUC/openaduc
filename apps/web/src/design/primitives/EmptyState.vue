<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
defineProps<{
  icon?: string;
  title: string;
  message?: string;
}>();
</script>

<template>
  <div class="ds-empty">
    <i v-if="icon" :class="icon" class="ds-empty-icon" />
    <div class="ds-empty-title">{{ title }}</div>
    <div v-if="message" class="ds-empty-msg">{{ message }}</div>
    <div v-if="$slots.actions" class="ds-empty-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.ds-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px 24px;
  color: var(--text-3);
  gap: 6px;
}

.ds-empty-icon {
  font-size: 24px;
  color: var(--text-4);
  margin-bottom: 4px;
}

.ds-empty-title {
  font-size: 13px;
  color: var(--text-2);
  font-weight: 500;
}

.ds-empty-msg {
  font-size: 12px;
  color: var(--text-3);
  max-width: 360px;
}

.ds-empty-actions {
  margin-top: 12px;
}
</style>
