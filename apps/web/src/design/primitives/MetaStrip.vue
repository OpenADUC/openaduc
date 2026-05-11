<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
interface MetaItem {
  label: string;
  value?: string | null;
  /** Optional router-link target. When set, the value renders as a link. */
  to?: string;
  /** Optional icon (PrimeIcons class) shown before the label. */
  icon?: string;
  /** Render value with the monospace font (DNs, IDs, GUIDs). */
  mono?: boolean;
}

defineProps<{ items: MetaItem[] }>();
</script>

<template>
  <dl class="meta-strip">
    <div v-for="item in items" :key="item.label" class="meta-row">
      <dt>
        <i v-if="item.icon" :class="item.icon" />
        <span>{{ item.label }}</span>
      </dt>
      <dd :class="{ mono: item.mono }">
        <RouterLink v-if="item.to && item.value" :to="item.to" class="meta-link">
          {{ item.value }}
        </RouterLink>
        <template v-else-if="item.value">{{ item.value }}</template>
        <span v-else class="meta-empty">—</span>
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.meta-strip {
  display: grid;
  gap: 8px 16px;
  margin: 0;
  grid-template-columns: max-content 1fr;
  align-content: start;
}

.meta-row {
  display: contents;
}

dt {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-3);
  letter-spacing: 0.02em;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 1px;
}

dt i {
  font-size: 11px;
  color: var(--text-4);
}

dd {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

dd.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.meta-empty {
  color: var(--text-4);
}

.meta-link {
  color: var(--accent-text);
  text-decoration: none;
}

.meta-link:hover {
  text-decoration: underline;
}
</style>
