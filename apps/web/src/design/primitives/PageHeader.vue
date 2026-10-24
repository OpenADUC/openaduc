<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
defineProps<{
  title: string;
  sub?: string;
}>();
</script>

<template>
  <header class="page-head">
    <div>
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="sub" class="page-sub">{{ sub }}</p>
    </div>
    <div v-if="$slots.actions" class="ph-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.ph-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

/* A crowded header wraps whole buttons, not their labels. */
.ph-actions > :deep(.p-button) {
  white-space: nowrap;
}
</style>
