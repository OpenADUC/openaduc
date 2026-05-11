<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ThemeToggle from '../primitives/ThemeToggle.vue';
import GlobalSearch from './GlobalSearch.vue';

const route = useRoute();

interface Crumb {
  label: string;
  to?: string;
}

const crumbs = computed<Crumb[]>(() => {
  const name = route.name as string | undefined;
  switch (name) {
    case 'dashboard':
      return [{ label: 'Dashboard' }];
    case 'user-search':
      return [{ label: 'Users' }];
    case 'user-detail':
      return [
        { label: 'Users', to: '/users' },
        {
          label: typeof route.params.id === 'string' ? route.params.id.slice(0, 8) + '…' : 'Detail',
        },
      ];
    case 'deleted-users':
      return [{ label: 'Users', to: '/users' }, { label: 'Deleted' }];
    case 'group-search':
      return [{ label: 'Groups' }];
    case 'group-detail':
      return [
        { label: 'Groups', to: '/groups' },
        {
          label: typeof route.params.id === 'string' ? route.params.id.slice(0, 8) + '…' : 'Detail',
        },
      ];
    case 'ou-browser':
      return [{ label: 'OUs' }];
    case 'audit':
      return [{ label: 'Auditing' }];
    case 'settings':
      return [{ label: 'Configuration' }];
    case 'appearance':
      return [{ label: 'Appearance' }];
    case 'computers':
      return [{ label: 'Computers' }];
    case 'group-policy':
      return [{ label: 'Group Policy' }];
    case 'group-policy-detail':
      return [
        { label: 'Group Policy', to: '/policies/groups' },
        {
          label: typeof route.params.id === 'string' ? route.params.id.slice(0, 8) + '…' : 'Detail',
        },
      ];
    case 'tasks':
      return [{ label: 'Tasks & Scheduler' }];
    default:
      return [{ label: typeof route.name === 'string' ? route.name : 'Page' }];
  }
});

const currentCrumb = computed(() => crumbs.value[crumbs.value.length - 1]?.label ?? '');

// On desktop we only show parent crumbs — the current page is obvious from the
// page heading, so listing it here is just noise. The mobile compact form
// still shows the current page since the sidebar is off-screen there.
const parentCrumbs = computed(() => crumbs.value.slice(0, -1));
</script>

<template>
  <header class="ds-topbar">
    <nav v-if="parentCrumbs.length > 0" class="crumbs" aria-label="Breadcrumb">
      <template v-for="(c, i) in parentCrumbs" :key="i">
        <RouterLink v-if="c.to" :to="c.to" class="crumb">{{ c.label }}</RouterLink>
        <span v-else class="crumb">{{ c.label }}</span>
        <span v-if="i < parentCrumbs.length - 1" class="crumb-sep">/</span>
      </template>
    </nav>
    <div class="crumbs-mobile">{{ currentCrumb }}</div>

    <GlobalSearch class="tb-search" />

    <div class="tb-actions">
      <ThemeToggle />
      <button
        type="button"
        class="tb-icon"
        title="Notifications (coming soon)"
        aria-label="Notifications"
      >
        <i class="pi pi-bell" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.ds-topbar {
  height: var(--topbar-h);
  flex: 0 0 var(--topbar-h);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  position: relative;
  z-index: 5;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 13px;
  min-width: 0;
  flex-shrink: 0;
}

.crumbs-mobile {
  display: none;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text);
  flex-shrink: 0;
}

.crumb {
  color: var(--text-2);
  white-space: nowrap;
  text-decoration: none;
}

.crumb-sep {
  color: var(--text-4);
}

.tb-search {
  flex: 1 1 auto;
}

.tb-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.tb-icon {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  cursor: pointer;
  color: var(--text-2);
  font-size: 14px;
}

.tb-icon:hover {
  background: var(--hover);
  color: var(--text);
  border-color: var(--border);
}

@media (max-width: 767.98px) {
  .crumbs {
    display: none;
  }

  .crumbs-mobile {
    display: block;
  }

  .ds-topbar {
    padding: 0 10px;
    gap: 8px;
  }

  .tb-icon[title*='Notifications'] {
    display: none;
  }
}
</style>
