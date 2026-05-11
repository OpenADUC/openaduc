<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { fmtRelative } from '../lib/format.js';

const props = withDefaults(
  defineProps<{
    /** When the data was last live-refreshed against AD. */
    liveAt?: string | Date | null;
    /** When the cache copy was last written. */
    cachedAt?: string | Date | null;
    /** Visual variant. */
    variant?: 'pill' | 'tag' | 'bar';
    /** How recent counts as "live" (default 30s). */
    freshThresholdMs?: number;
  }>(),
  { variant: 'pill', freshThresholdMs: 30_000 },
);

// Tick every 15s so the relative-time label and live/stale flip stay accurate
// without forcing the parent to re-render.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 15_000);
});

onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});

const referenceAt = computed(() => props.liveAt ?? props.cachedAt ?? null);

const isLive = computed(() => {
  if (!props.liveAt) return false;
  const refMs = new Date(props.liveAt).getTime();
  if (Number.isNaN(refMs)) return false;
  return now.value - refMs < props.freshThresholdMs;
});

const label = computed(() => (isLive.value ? 'LIVE' : 'cached'));
const relative = computed(() => fmtRelative(referenceAt.value, new Date(now.value)));
</script>

<template>
  <span v-if="variant === 'tag'" class="lc-tag" :class="{ cached: !isLive }">
    <span v-if="isLive" class="lc-dot pulse" />
    {{ label }}
    <span v-if="relative" class="lc-rel">· {{ relative }}</span>
  </span>

  <span v-else-if="variant === 'bar'" class="lc-bar" :class="{ cached: !isLive }">
    {{ label }}
    <span v-if="relative" class="lc-rel">· {{ relative }}</span>
  </span>

  <span v-else class="lc-pill" :class="isLive ? 'live' : 'cached'">
    <span class="lc-dot" :class="{ pulse: isLive }" />
    {{ label }}
    <span v-if="relative" class="lc-rel">· {{ relative }}</span>
  </span>
</template>

<style scoped>
.lc-rel {
  color: var(--text-3);
  font-weight: 400;
}
</style>
