<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import Message from 'primevue/message';
import Button from 'primevue/button';

// A failed write, shown beside what failed until the operator retries or
// dismisses it.
defineProps<{ summary: string; message: string; busy?: boolean }>();
defineEmits<{ retry: []; dismiss: [] }>();
</script>

<template>
  <Message severity="error" closable class="inline-failure" @close="$emit('dismiss')">
    <div class="inline-failure-body">
      <div class="inline-failure-text">
        <strong>{{ summary }}</strong>
        <div>{{ message }}</div>
      </div>
      <Button
        label="Retry"
        icon="pi pi-refresh"
        size="small"
        severity="danger"
        text
        :loading="busy"
        @click="$emit('retry')"
      />
    </div>
  </Message>
</template>

<style scoped>
.inline-failure-body {
  display: flex;
  align-items: center;
  gap: 12px;
}

.inline-failure-text {
  flex: 1;
  min-width: 0;
}
</style>
