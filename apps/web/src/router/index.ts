// SPDX-License-Identifier: BUSL-1.1
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { api } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';

const routes: RouteRecordRaw[] = [
  {
    path: '/setup',
    name: 'setup',
    meta: { layout: 'bare', public: true, allowDuringSetup: true },
    component: () => import('../views/SetupView.vue'),
  },
  {
    path: '/login',
    name: 'login',
    meta: { layout: 'bare', public: true },
    component: () => import('../views/LoginView.vue'),
  },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('../views/DashboardView.vue'),
  },
  {
    path: '/users',
    name: 'user-search',
    component: () => import('../views/UserSearchView.vue'),
  },
  {
    // Static segment — wins over `/users/:id` regardless of order due to
    // vue-router's specificity ranking, but we declare it first for clarity.
    path: '/users/deleted',
    name: 'deleted-users',
    component: () => import('../views/DeletedUsersView.vue'),
  },
  {
    path: '/users/:id',
    name: 'user-detail',
    component: () => import('../views/UserDetailView.vue'),
    props: true,
  },
  {
    path: '/groups',
    name: 'group-search',
    component: () => import('../views/GroupSearchView.vue'),
  },
  {
    path: '/browse',
    name: 'ou-browser',
    component: () => import('../views/OuBrowserView.vue'),
  },
  {
    path: '/groups/:id',
    name: 'group-detail',
    component: () => import('../views/GroupDetailView.vue'),
    props: true,
  },
  {
    path: '/computers',
    name: 'computer-search',
    component: () => import('../views/ComputerSearchView.vue'),
  },
  {
    // Static segment — declared before the dynamic `/computers/:id` so
    // vue-router resolves it correctly without relying on registration order.
    path: '/computers/deleted',
    name: 'deleted-computers',
    component: () => import('../views/DeletedComputersView.vue'),
  },
  {
    path: '/computers/:id',
    name: 'computer-detail',
    component: () => import('../views/ComputerDetailView.vue'),
    props: true,
  },
  {
    path: '/audit',
    name: 'audit',
    component: () => import('../views/AuditView.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
  },
  {
    path: '/appearance',
    name: 'appearance',
    component: () => import('../views/AppearanceView.vue'),
  },
  {
    path: '/policies/groups',
    name: 'group-policy',
    component: () => import('../views/GroupPolicyListView.vue'),
  },
  {
    path: '/policies/groups/:id',
    name: 'group-policy-detail',
    component: () => import('../views/GroupPolicyDetailView.vue'),
    props: true,
  },
  // Coming-soon stubs. Each route shares ComingSoonView.vue and identifies
  // itself via meta.feature so the placeholder can render the right copy.
  {
    path: '/tasks',
    name: 'tasks',
    component: () => import('../views/TasksView.vue'),
  },
  // Catch-all -> dashboard.
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Cache the setup-needed answer for one router tick. The /setup view itself
// re-queries on mount to present the right step.
//
// "Setup needed" means the multi-step wizard has not yet finished — distinct
// from "directory configured", which only confirms step 1. The wizard owns
// service-account, password-policy, and initial-sync steps after that, and
// we keep the operator pinned to /setup until the entire flow is done so
// they don't end up with a configured directory but no synced data.
let setupChecked = false;
let setupNeeded = false;

async function ensureSetupChecked(): Promise<void> {
  if (setupChecked) return;
  try {
    const status = await api.setup.status();
    setupNeeded = !status.onboardingCompletedAt;
  } catch {
    // If the status endpoint fails, assume setup is needed so the user lands
    // somewhere actionable rather than seeing a broken login page.
    setupNeeded = true;
  }
  setupChecked = true;
}

router.beforeEach(async (to) => {
  await ensureSetupChecked();
  // If setup isn't done, force everything (except /setup itself) to /setup.
  if (setupNeeded && to.meta.allowDuringSetup !== true) {
    return { name: 'setup' };
  }
  // If setup IS done and someone hits /setup, send them to login.
  if (!setupNeeded && to.name === 'setup') {
    return { name: 'login' };
  }

  const auth = useAuthStore();
  if (!auth.initialized) {
    await auth.refresh();
  }
  if (to.meta.public === true) {
    if (auth.isAuthenticated && to.name === 'login') {
      return { name: 'dashboard' };
    }
    return true;
  }
  if (!auth.isAuthenticated) {
    return { name: 'login', query: { next: to.fullPath } };
  }
  return true;
});

/** Re-check setup state on next navigation (used after the wizard finishes). */
export function invalidateSetupCheck(): void {
  setupChecked = false;
}
