<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '../design/primitives/PageHeader.vue';

interface FeatureSpec {
  title: string;
  icon: string;
  description: string;
  bullets: string[];
}

const FEATURES: Record<string, FeatureSpec> = {
  computers: {
    title: 'Computers',
    icon: 'pi pi-desktop',
    description:
      'Inventory and manage computer accounts: workstations, servers, and lab machines pulled from your directory.',
    bullets: [
      'List computer accounts with last logon, OS, and join state',
      'Filter stale machines and orphaned accounts',
      'Move, disable, or delete with the same step-up flow used for users',
    ],
  },
};

const route = useRoute();

const feature = computed<FeatureSpec>(() => {
  const key = (route.meta.feature as string | undefined) ?? '';
  return (
    FEATURES[key] ?? {
      title: 'Coming soon',
      icon: 'pi pi-sparkles',
      description: 'This area is reserved for a feature in development.',
      bullets: [],
    }
  );
});
</script>

<template>
  <div class="page-inner cs-page">
    <PageHeader :title="feature.title" sub="planned · coming soon" />

    <section class="cs-card">
      <div class="cs-icon">
        <i :class="feature.icon" />
      </div>
      <div class="cs-body">
        <div class="cs-tag">Coming soon</div>
        <h2 class="cs-title">{{ feature.title }}</h2>
        <p class="cs-desc">{{ feature.description }}</p>
        <ul v-if="feature.bullets.length > 0" class="cs-bullets">
          <li v-for="b in feature.bullets" :key="b">
            <i class="pi pi-check" />
            <span>{{ b }}</span>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cs-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cs-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px;
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 24px;
  align-items: start;
}

.cs-icon {
  width: 80px;
  height: 80px;
  border-radius: 18px;
  background: var(--accent-soft);
  color: var(--accent-text);
  display: grid;
  place-items: center;
  font-size: 30px;
}

.cs-body {
  min-width: 0;
}

.cs-tag {
  display: inline-block;
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
  margin-bottom: 10px;
}

.cs-title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}

.cs-desc {
  margin: 0 0 16px;
  font-size: 14px;
  color: var(--text-2);
  line-height: 1.55;
  max-width: 64ch;
}

.cs-bullets {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.cs-bullets li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  color: var(--text-2);
}

.cs-bullets i {
  color: var(--accent-text);
  margin-top: 4px;
  font-size: 11px;
}

@media (max-width: 639.98px) {
  .cs-card {
    grid-template-columns: 1fr;
    padding: 20px;
  }
  .cs-icon {
    width: 56px;
    height: 56px;
    font-size: 22px;
    border-radius: 14px;
  }
}
</style>
