<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    sub?: string;
    flush?: boolean;
  }>(),
  { flush: false },
);
</script>

<template>
  <section class="dc-card">
    <header v-if="title || $slots.head || sub || $slots.actions" class="dc-card-head">
      <div>
        <h3 v-if="title" class="dc-card-title">{{ title }}</h3>
        <slot name="head" />
        <div v-if="sub" class="dc-card-sub">{{ sub }}</div>
      </div>
      <div v-if="$slots.actions" class="dc-card-actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="dc-card-body" :class="{ flush }">
      <slot />
    </div>
    <footer v-if="$slots.foot" class="dc-card-foot">
      <slot name="foot" />
    </footer>
  </section>
</template>

<style scoped>
.dc-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
