<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    icon?: string;
    sub?: string;
    /** Number of columns at >=md width. The body falls back to 1-col on mobile. */
    cols?: 1 | 2 | 3;
  }>(),
  { cols: 2 },
);
</script>

<template>
  <section class="sc">
    <header v-if="title || $slots.actions" class="sc-head">
      <div class="sc-head-l">
        <i v-if="icon" class="sc-icon" :class="icon" />
        <div class="sc-head-text">
          <h3 v-if="title" class="sc-title">{{ title }}</h3>
          <div v-if="sub" class="sc-sub">{{ sub }}</div>
        </div>
      </div>
      <div v-if="$slots.actions" class="sc-actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="sc-body" :class="`cols-${cols}`">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.sc {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.sc-head {
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--border);
  min-height: 50px;
}

.sc-head-l {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.sc-icon {
  color: var(--accent-text);
  font-size: 14px;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  border-radius: 6px;
}

.sc-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
  letter-spacing: -0.005em;
}

.sc-sub {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 1px;
}

.sc-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.sc-body {
  padding: 16px;
  display: grid;
  gap: 14px 28px;
  grid-template-columns: 1fr;
}

@media (min-width: 768px) {
  .sc-body.cols-2 {
    grid-template-columns: 1fr 1fr;
  }
  .sc-body.cols-3 {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
