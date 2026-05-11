<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    delta?: string | null;
    deltaTone?: 'up' | 'down' | 'warn' | 'muted';
    icon?: string | null;
    sub?: string | null;
    accent?: string | null;
  }>(),
  { deltaTone: 'up' },
);
</script>

<template>
  <div class="kpi">
    <div class="kpi-label">
      <i v-if="icon" :class="icon" />
      {{ label }}
    </div>
    <div class="kpi-value" :style="accent ? { color: accent } : undefined">{{ value }}</div>
    <div class="kpi-delta-row">
      <span v-if="delta" class="kpi-delta" :class="deltaTone">{{ delta }}</span>
      <span v-if="sub" class="kpi-delta">{{ sub }}</span>
      <slot name="spark" />
    </div>
  </div>
</template>

<style scoped>
.kpi-delta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>
