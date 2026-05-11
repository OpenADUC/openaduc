<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import { useAuthStore } from '../../stores/auth.js';
import { useThemeStore } from '../stores/useTheme.js';
import { initialsFor, avatarGradientFor } from '../lib/format.js';
import Wordmark from '../primitives/Wordmark.vue';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  capability?: string;
  /** Renders a small "soon" pill next to the label. Item still routes. */
  soon?: boolean;
}

interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

const auth = useAuthStore();
const theme = useThemeStore();
const router = useRouter();

const userMenuRef = ref<InstanceType<typeof Menu> | null>(null);

async function logout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}

const userMenuItems = computed<MenuItem[]>(() => [
  {
    label: auth.actor?.displayName ?? auth.actor?.username ?? 'Operator',
    items: [
      {
        label: 'Sign out',
        icon: 'pi pi-sign-out',
        command: () => {
          void logout();
        },
      },
    ],
  },
]);

function toggleUserMenu(event: Event): void {
  userMenuRef.value?.toggle(event);
}

// Three-section IA: Directory (object surfaces), Management (operations on
// the directory), Settings (configuration). Items marked `soon` route to a
// shared coming-soon placeholder so the IA is discoverable today.
const sections: NavSection[] = [
  {
    id: 'directory',
    label: 'Directory',
    items: [
      { to: '/', label: 'Dashboard', icon: 'pi pi-th-large' },
      { to: '/users', label: 'Users', icon: 'pi pi-users' },
      { to: '/groups', label: 'Groups', icon: 'pi pi-objects-column', capability: 'read:group' },
      { to: '/computers', label: 'Computers', icon: 'pi pi-desktop', capability: 'read:computer' },
      { to: '/browse', label: 'OUs', icon: 'pi pi-folder-open' },
      {
        to: '/policies/groups',
        label: 'Group Policy',
        icon: 'pi pi-clipboard',
        capability: 'read:group',
      },
    ],
  },
  {
    id: 'management',
    label: 'Management',
    items: [
      { to: '/audit', label: 'Auditing', icon: 'pi pi-shield', capability: 'view:audit' },
      {
        to: '/tasks',
        label: 'Tasks & Scheduler',
        icon: 'pi pi-clock',
        capability: 'configure:directory',
      },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [
      { to: '/settings', label: 'Configuration', icon: 'pi pi-server' },
      { to: '/appearance', label: 'Appearance', icon: 'pi pi-palette' },
    ],
  },
];

function visible(item: NavItem): boolean {
  if (!item.capability) return true;
  return auth.hasCapability(item.capability);
}

const visibleSections = computed(() =>
  sections.map((s) => ({ ...s, items: s.items.filter(visible) })).filter((s) => s.items.length > 0),
);

const actorName = computed(() => auth.actor?.displayName ?? auth.actor?.username ?? 'Operator');
const actorRole = computed(() => {
  const caps = auth.actor?.capabilities ?? [];
  if (caps.length === 0) return 'no role';
  if (caps.some((c) => c.startsWith('write:'))) return 'admin';
  if (caps.includes('view:audit')) return 'auditor';
  return 'helpdesk';
});
const initials = computed(() => initialsFor(actorName.value));
const avatarBg = computed(() => avatarGradientFor(actorName.value));
</script>

<template>
  <aside class="ds-sidebar" :class="{ 'is-collapsed': theme.sidebarCollapsed }">
    <button
      v-tooltip.right="theme.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
      type="button"
      class="sb-brand"
      :aria-label="theme.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
      :aria-expanded="!theme.sidebarCollapsed"
      @click="theme.toggleSidebar()"
    >
      <img class="sb-brand-mark" src="/branding/logo.png" alt="OpenADUC" />
      <div v-if="!theme.sidebarCollapsed" class="sb-brand-text-wrap">
        <Wordmark class="sb-brand-text" />
      </div>
    </button>

    <div class="sb-scroll">
      <div v-for="section in visibleSections" :key="section.id" class="sb-section">
        <div class="sb-section-label">{{ section.label }}</div>
        <RouterLink
          v-for="item in section.items"
          :key="item.to"
          v-tooltip.right="theme.sidebarCollapsed ? item.label : undefined"
          :to="item.to"
          class="sb-item"
          active-class="active"
          :exact-active-class="item.to === '/' ? 'active' : ''"
        >
          <i class="sb-item-icon" :class="item.icon" />
          <span v-if="!theme.sidebarCollapsed" class="sb-item-label">{{ item.label }}</span>
          <span v-if="!theme.sidebarCollapsed && item.soon" class="sb-item-soon">soon</span>
        </RouterLink>
      </div>
    </div>

    <div class="sb-foot">
      <button
        v-tooltip.right="theme.sidebarCollapsed ? actorName : undefined"
        type="button"
        class="sb-foot-user"
        aria-haspopup="true"
        aria-controls="sidebar-user-menu"
        @click="toggleUserMenu"
      >
        <span class="sb-avatar" :style="{ background: avatarBg }">{{ initials }}</span>
        <span v-if="!theme.sidebarCollapsed" class="sb-foot-meta">
          <span class="sb-foot-name">{{ actorName }}</span>
          <span class="sb-foot-role">{{ actorRole }}</span>
        </span>
        <i v-if="!theme.sidebarCollapsed" class="pi pi-angle-up sb-foot-chev" />
      </button>
      <Menu id="sidebar-user-menu" ref="userMenuRef" :model="userMenuItems" :popup="true" />
    </div>
  </aside>
</template>

<style scoped>
.ds-sidebar {
  background: var(--bg-1);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  width: var(--sb-w);
  transition: width 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.ds-sidebar.is-collapsed {
  width: var(--sb-w-collapsed);
}

.sb-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 14px 14px 16px;
  height: var(--topbar-h);
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  width: 100%;
  flex: 0 0 auto;
  transition: background 0.12s ease;
}

.sb-brand:hover {
  background: var(--hover);
}

.sb-brand:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.is-collapsed .sb-brand {
  justify-content: center;
  padding: 14px 8px;
}

.sb-brand-mark {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 6px;
  object-fit: contain;
  display: block;
}

.sb-brand-text {
  font-weight: 600;
  font-size: 14px;
  letter-spacing: -0.005em;
  white-space: nowrap;
  overflow: hidden;
  color: var(--text);
}

.sb-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}

.sb-section {
  padding: 12px 8px 4px;
}

.sb-section + .sb-section {
  padding-top: 14px;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}

.sb-section-label {
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 0 10px 6px;
  white-space: nowrap;
  overflow: hidden;
}

.is-collapsed .sb-section-label {
  opacity: 0;
  height: 0;
  padding: 0;
}

.sb-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  position: relative;
  text-decoration: none;
  margin-bottom: 1px;
}

.sb-item:hover {
  background: var(--hover);
  color: var(--text);
}

.sb-item.active {
  background: var(--surface-2);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.sb-item.active::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
}

.sb-item-icon {
  width: 16px;
  display: grid;
  place-items: center;
  flex: 0 0 16px;
  color: var(--text-3);
  font-size: 14px;
}

.sb-item.active .sb-item-icon,
.sb-item:hover .sb-item-icon {
  color: var(--text);
}

.sb-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sb-item-soon {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
  flex-shrink: 0;
}

.is-collapsed .sb-item {
  justify-content: center;
  padding: 8px;
}

.is-collapsed .sb-item.active::before {
  left: 0;
}

.sb-foot {
  border-top: 1px solid var(--border);
  padding: 8px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.sb-foot-user {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--text);
}

.sb-foot-user:hover {
  background: var(--hover);
  border-color: var(--border);
}

.sb-avatar {
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: 50%;
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.sb-foot-meta {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.sb-foot-name {
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.sb-foot-role {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
}

.sb-foot-chev {
  color: var(--text-3);
  font-size: 10px;
  flex-shrink: 0;
}

.is-collapsed .sb-foot {
  justify-content: center;
  padding: 10px 8px;
}

.is-collapsed .sb-foot-user {
  flex: 0 0 auto;
  padding: 4px;
}
</style>
