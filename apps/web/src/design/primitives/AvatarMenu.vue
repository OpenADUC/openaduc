<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import { useAuthStore } from '../../stores/auth.js';
import Avatar from './Avatar.vue';

const auth = useAuthStore();
const router = useRouter();

const name = computed(() => auth.actor?.displayName ?? auth.actor?.username ?? 'Operator');
const role = computed(() => {
  const caps = auth.actor?.capabilities ?? [];
  if (caps.length === 0) return 'no role';
  if (caps.some((c) => c.startsWith('write:'))) return 'admin';
  if (caps.includes('view:audit')) return 'auditor';
  return 'helpdesk';
});
const directoryDomain = computed(() => auth.actor?.directoryDomain ?? null);

const menuRef = ref<InstanceType<typeof Menu> | null>(null);

async function logout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}

const items = computed<MenuItem[]>(() => [
  {
    label: name.value,
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

function toggle(event: Event): void {
  menuRef.value?.toggle(event);
}
</script>

<template>
  <div class="avatar-menu">
    <button
      type="button"
      class="am-trigger"
      aria-haspopup="true"
      aria-controls="avatar-menu-popup"
      :title="name"
      @click="toggle"
    >
      <Avatar :name="name" :size="28" />
      <span class="am-meta">
        <span class="am-name">{{ name }}</span>
        <span class="am-sub">
          <span class="am-role">{{ role }}</span>
          <template v-if="directoryDomain">
            <span class="am-dot">·</span>
            <span class="am-domain">{{ directoryDomain }}</span>
          </template>
        </span>
      </span>
      <i class="pi pi-angle-down am-chev" />
    </button>
    <Menu id="avatar-menu-popup" ref="menuRef" :model="items" :popup="true" />
  </div>
</template>

<style scoped>
.avatar-menu {
  display: inline-flex;
}

.am-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
  cursor: pointer;
  color: var(--text);
}

.am-trigger:hover {
  background: var(--hover);
  border-color: var(--border);
}

.am-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.15;
  min-width: 0;
}

.am-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-sub {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  display: flex;
  gap: 4px;
}

.am-dot {
  color: var(--text-4);
}

.am-chev {
  color: var(--text-3);
  font-size: 10px;
}

@media (max-width: 639.98px) {
  .am-meta {
    display: none;
  }

  .am-trigger {
    padding: 4px;
  }

  .am-chev {
    display: none;
  }
}
</style>
