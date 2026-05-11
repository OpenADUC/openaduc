<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import PageHeader from '../design/primitives/PageHeader.vue';
import DirectoryTab from './settings/DirectoryTab.vue';
import PolicyTab from './settings/PolicyTab.vue';
import IntegrationsTab from './settings/IntegrationsTab.vue';

type TabId = 'directory' | 'policy' | 'integrations';

interface TabSpec {
  id: TabId;
  label: string;
  icon: string;
  capability?: string;
}

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

// Configuration page tabs: Domains (directory) for AD connection details,
// Policy & audit for password/security policy, Entra ID for the Microsoft
// Graph integration. Appearance lives at its own /appearance route.
const allTabs: TabSpec[] = [
  {
    id: 'directory',
    label: 'Domains',
    icon: 'pi pi-server',
    capability: 'configure:directory',
  },
  { id: 'policy', label: 'Policy & audit', icon: 'pi pi-shield', capability: 'configure:security' },
  { id: 'integrations', label: 'Entra ID', icon: 'pi pi-share-alt' },
];

const visibleTabs = computed(() =>
  allTabs.filter((t) => !t.capability || auth.hasCapability(t.capability)),
);

const activeTab = ref<TabId>('directory');

// Preserve the active tab in the URL (`/settings?tab=directory`) so links
// from elsewhere in the UI (e.g. "set policy in Settings") deep-link the
// right place. Falls back to the first capability-visible tab.
watchEffect(() => {
  const fromQuery = route.query.tab;
  if (typeof fromQuery === 'string' && visibleTabs.value.some((t) => t.id === fromQuery)) {
    activeTab.value = fromQuery as TabId;
  } else if (!visibleTabs.value.some((t) => t.id === activeTab.value)) {
    activeTab.value = visibleTabs.value[0]?.id ?? 'directory';
  }
});

function selectTab(id: TabId): void {
  activeTab.value = id;
  void router.replace({ path: '/settings', query: { tab: id } });
}
</script>

<template>
  <div class="page-inner settings-page">
    <PageHeader title="Configuration" />

    <nav class="ds-tabs" role="tablist">
      <button
        v-for="t in visibleTabs"
        :key="t.id"
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ active: activeTab === t.id }"
        :aria-selected="activeTab === t.id"
        @click="selectTab(t.id)"
      >
        <i :class="t.icon" />
        {{ t.label }}
      </button>
    </nav>

    <div class="settings-content">
      <DirectoryTab v-if="activeTab === 'directory'" />
      <PolicyTab v-else-if="activeTab === 'policy'" />
      <IntegrationsTab v-else-if="activeTab === 'integrations'" />
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ds-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}

.ds-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: 0;
  padding: 9px 14px;
  color: var(--text-3);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  position: relative;
  border-radius: 6px 6px 0 0;
  font-family: var(--font-sans);
}

.ds-tab:hover {
  color: var(--text);
}

.ds-tab.active {
  color: var(--text);
}

.ds-tab.active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
}

.settings-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
