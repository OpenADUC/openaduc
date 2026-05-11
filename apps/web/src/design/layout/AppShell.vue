<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import Sidebar from './Sidebar.vue';
import Topbar from './Topbar.vue';
import StepUpDialog from '../feedback/StepUpDialog.vue';
import EditModeFab from '../primitives/EditModeFab.vue';
import EditModeStatusPill from '../primitives/EditModeStatusPill.vue';
import OldSchoolMmc from '../../oldschool/OldSchoolMmc.vue';
import { useAuthStore } from '../../stores/auth.js';
import { useResponsive } from '../composables/useResponsive.js';
import { useThemeStore } from '../stores/useTheme.js';

const route = useRoute();
const showShell = computed(() => route.meta.layout !== 'bare');
const auth = useAuthStore();
const theme = useThemeStore();
const { isMobile } = useResponsive();

// Old School takes over the entire browser window — sidebar, topbar, and
// page content all hide behind the MMC overlay. The operator returns to
// the app by hitting File → Exit / Close / Minimize inside the MMC,
// which navigates back to /appearance and flips the toggle off.
// We exempt /appearance and /settings (and the bare layouts handled
// above) so those pages remain reachable when the toggle is on.
const oldSchoolActive = computed(() => {
  if (!theme.oldSchool) return false;
  const name = route.name;
  if (name === 'appearance' || name === 'settings' || name === 'login' || name === 'setup') {
    return false;
  }
  return showShell.value;
});

// At narrow viewports the sidebar collapses to an icon-only rail rather than
// disappearing. We force-collapse on entering mobile width and restore the
// user's prior preference when widening back, so a desktop expansion isn't
// lost just because the window briefly shrank.
const preMobileCollapsed = ref(theme.sidebarCollapsed);

watch(
  isMobile,
  (mobile, wasMobile) => {
    if (mobile && !wasMobile) {
      preMobileCollapsed.value = theme.sidebarCollapsed;
      theme.sidebarCollapsed = true;
    } else if (!mobile && wasMobile) {
      theme.sidebarCollapsed = preMobileCollapsed.value;
    }
  },
  { immediate: true },
);

// Global StepUpDialog. Mounted once at the shell level so any view (or
// the API client itself, on a 'step_up_required' response) can flip
// `auth.stepUpRequested` to open the dialog without each view needing
// to own its own copy. The reason field is populated when the dialog
// opened automatically (e.g. cached step-up password expired); the
// EditModeFab leaves it null for a normal user-initiated open.
function onDialogVisibility(open: boolean): void {
  auth.stepUpRequested = open;
  if (!open) {
    auth.stepUpReason = null;
    // Clear any retry callback queued by the action that opened this dialog.
    // The success path already cleared it inside `auth.stepUp(...)`; this
    // covers the cancel/X-close case so a stale callback doesn't fire on
    // an unrelated future step-up.
    auth.stepUpPendingAction = null;
  }
}
</script>

<template>
  <!-- Bare layout: centered card on the page background. Used for login/setup. -->
  <div v-if="!showShell" class="ds-bare">
    <slot />
  </div>

  <!-- Full app shell with sidebar + topbar. -->
  <div v-else class="ds-app">
    <Sidebar />
    <main class="ds-main">
      <Topbar />
      <div class="ds-page page">
        <slot />
      </div>
    </main>
    <StepUpDialog
      :visible="auth.stepUpRequested"
      :reason="auth.stepUpReason"
      @update:visible="onDialogVisibility"
    />
    <EditModeFab />
    <EditModeStatusPill />

    <!-- Old School: full-viewport overlay covering sidebar, topbar, and
         page. Mounted at the shell level so it lives on top of every
         non-bare route. -->
    <OldSchoolMmc v-if="oldSchoolActive" />
  </div>
</template>

<style scoped>
.ds-app {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}

.ds-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: var(--bg);
}

.ds-page {
  flex: 1;
  /* Reserve gutter for the scrollbar even when the current page is short
     enough not to need one. Without this, switching from a long tab
     (Activity, Raw) to a short one (Overview) shifts the layout sideways
     by ~15px as the scrollbar appears/disappears. */
  overflow-y: scroll;
  scrollbar-gutter: stable;
  overflow-x: hidden;
  min-height: 0;
}

.ds-bare {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  color: var(--text);
  padding: 24px;
}
</style>
