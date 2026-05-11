<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    data: number[];
    height?: number;
    accent?: string;
  }>(),
  { height: 28 },
);

const w = 100;
const points = computed(() => {
  if (props.data.length === 0) return '';
  const max = Math.max(...props.data);
  const min = Math.min(...props.data);
  const span = max - min || 1;
  const h = props.height;
  return props.data
    .map((v, i) => {
      const x = (i / Math.max(1, props.data.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x},${y}`;
    })
    .join(' ');
});

const fillPolyline = computed(() => `0,${props.height} ${points.value} ${w},${props.height}`);
const stroke = computed(() => props.accent ?? 'var(--accent)');
</script>

<template>
  <svg
    class="ds-spark"
    :viewBox="`0 0 ${w} ${height}`"
    preserveAspectRatio="none"
    width="100%"
    :height="height"
  >
    <polyline :points="points" fill="none" :stroke="stroke" stroke-width="1.4" />
    <polyline :points="fillPolyline" :fill="stroke" opacity="0.08" />
  </svg>
</template>

<style scoped>
.ds-spark {
  margin-top: 4px;
}
</style>
