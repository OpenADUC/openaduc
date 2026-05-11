<!-- SPDX-License-Identifier: BUSL-1.1
     Old School: the classic ADUC MMC window painted on top of the app.

     Composition (top → bottom):
       Title bar       — "Active Directory Users and Computers"
       Menu bar        — File / Action / View / Help (with dropdowns)
       Toolbar         — Back, Forward, Up, Refresh, Properties, Find, ...
       Body            — OuTreePane | ContentsListPane
       Status bar      — selection summary

     Mounted dialogs   — driven by useOldSchool().windows. Each entry
     is a free-floating WinDialog with its own x/y/width/height/z; the
     operator can drag, resize, and open multiple side by side (think
     two user Properties dialogs open at once to diff group lists).
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Toast from 'primevue/toast';
import { useThemeStore } from '../design/stores/useTheme.js';
import { useOldSchool } from './stores/useOldSchool.js';
import OuTreePane from './panes/OuTreePane.vue';
import ContentsListPane from './panes/ContentsListPane.vue';
import WinIcon from './primitives/WinIcon.vue';
import UserPropertiesDialog from './dialogs/UserPropertiesDialog.vue';
import GroupPropertiesDialog from './dialogs/GroupPropertiesDialog.vue';
import ComputerPropertiesDialog from './dialogs/ComputerPropertiesDialog.vue';
import ResetPasswordDialog from './dialogs/ResetPasswordDialog.vue';
import MoveDialog from './dialogs/MoveDialog.vue';
import AddToGroupDialog from './dialogs/AddToGroupDialog.vue';
import ConfirmDialog from './dialogs/ConfirmDialog.vue';
import AboutDialog from './dialogs/AboutDialog.vue';
import FindDialog from './dialogs/FindDialog.vue';

const theme = useThemeStore();
const store = useOldSchool();
const router = useRouter();

// --- Menu state -------------------------------------------------------
type MenuId = 'file' | 'action' | 'view' | 'help' | null;
const openMenu = ref<MenuId>(null);

function toggleMenu(id: MenuId): void {
  openMenu.value = openMenu.value === id ? null : id;
}

function onMenuItem(action: () => void): void {
  openMenu.value = null;
  action();
}

function onDocClick(e: MouseEvent): void {
  if (!openMenu.value) return;
  const target = e.target as HTMLElement;
  if (!target.closest('.os-menubar') && !target.closest('.os-menu-dropdown')) {
    openMenu.value = null;
  }
}
// --- Keyboard shortcuts ----------------------------------------------
// F5 refreshes; Ctrl+F opens Find. Match the bindings MMC ships with.
// We skip when a dialog is open so the dialog's own Escape handling
// (and form typing) take priority.
function onKey(e: KeyboardEvent): void {
  if (store.anyDialog) return;
  if (e.key === 'F5') {
    e.preventDefault();
    store.bumpData();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    store.openDialog({ kind: 'find' });
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick, true);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick, true);
  document.removeEventListener('keydown', onKey);
});

// --- Tree resize ------------------------------------------------------
const treeWidth = ref(280);
function startResize(e: MouseEvent): void {
  const startX = e.clientX;
  const startW = treeWidth.value;
  const onMove = (ev: MouseEvent): void => {
    treeWidth.value = Math.max(160, Math.min(640, startW + (ev.clientX - startX)));
  };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// --- Footer status text ----------------------------------------------
const statusLeft = computed(() => {
  const n = store.selectedRows.length;
  if (n === 0) return store.selectedNode.label;
  if (n === 1) return store.selectedRows[0]!.label;
  return `${n} items selected`;
});
const statusRight = computed(() => store.selectedNode.dn ?? '');

// Exit / close / minimize all take the operator back to the
// Appearance page (where they turned this on) and flip the toggle
// off. Matches the user's mental model: closing the MMC window
// returns to the modern app settings — there's nothing else for
// these buttons to do.
function exitOldSchool(): void {
  theme.setOldSchool(false);
  void router.push({ name: 'appearance' });
}
</script>

<template>
  <div class="os-host">
    <div class="os-root" :style="{ ['--os-tree-width' as any]: `${treeWidth}px` }">
      <!-- ============ Title bar ============ -->
      <div class="os-titlebar">
        <WinIcon class="os-titlebar-icon" name="aduc" :size="16" />
        <div class="os-titlebar-title">Active Directory Users and Computers</div>
        <div class="os-titlebar-controls">
          <button class="os-titlebar-btn" type="button" title="Minimize" @click="exitOldSchool">
            —
          </button>
          <button class="os-titlebar-btn" type="button" title="Maximize" disabled>▢</button>
          <button
            class="os-titlebar-btn close"
            type="button"
            title="Exit Old School"
            @click="exitOldSchool"
          >
            ✕
          </button>
        </div>
      </div>

      <!-- ============ Menu bar ============ -->
      <div class="os-menubar">
        <div
          class="os-menu-item"
          :class="{ open: openMenu === 'file' }"
          @click="toggleMenu('file')"
        >
          <span class="os-menu-underline">F</span>ile
          <div v-if="openMenu === 'file'" class="os-menu-dropdown">
            <div class="os-menu-row disabled"><span class="os-menu-icon" />Options…</div>
            <div class="os-menu-separator" />
            <div class="os-menu-row" @click="onMenuItem(exitOldSchool)">
              <span class="os-menu-icon" /><span>Exit</span>
            </div>
          </div>
        </div>
        <div
          class="os-menu-item"
          :class="{ open: openMenu === 'action' }"
          @click="toggleMenu('action')"
        >
          <span class="os-menu-underline">A</span>ction
          <div v-if="openMenu === 'action'" class="os-menu-dropdown">
            <div class="os-menu-row" @click="onMenuItem(() => store.bumpData())">
              <span class="os-menu-icon"><WinIcon name="refresh" :size="14" /></span>
              <span>Refresh</span>
              <span class="os-menu-accel">F5</span>
            </div>
            <div class="os-menu-row" @click="onMenuItem(() => store.openDialog({ kind: 'find' }))">
              <span class="os-menu-icon"><WinIcon name="find" :size="14" /></span>
              <span>Find…</span>
              <span class="os-menu-accel">Ctrl+F</span>
            </div>
            <div class="os-menu-separator" />
            <div class="os-menu-row disabled"><span class="os-menu-icon" />New ▸</div>
            <div class="os-menu-row disabled"><span class="os-menu-icon" />All Tasks ▸</div>
            <div class="os-menu-separator" />
            <div class="os-menu-row disabled"><span class="os-menu-icon" />View ▸</div>
            <div class="os-menu-row disabled"><span class="os-menu-icon" />Help</div>
          </div>
        </div>
        <div
          class="os-menu-item"
          :class="{ open: openMenu === 'view' }"
          @click="toggleMenu('view')"
        >
          <span class="os-menu-underline">V</span>iew
          <div v-if="openMenu === 'view'" class="os-menu-dropdown">
            <div class="os-menu-row disabled"><span class="os-menu-icon" />Add/Remove Columns…</div>
            <div class="os-menu-row disabled"><span class="os-menu-icon" />Large Icons</div>
            <div class="os-menu-row disabled"><span class="os-menu-icon" />Small Icons</div>
            <div class="os-menu-row disabled"><span class="os-menu-icon" />List</div>
            <div class="os-menu-row">
              <span class="os-menu-icon"><WinIcon name="menu-check" :size="14" /></span>
              <span>Detail</span>
            </div>
            <div class="os-menu-separator" />
            <div class="os-menu-row disabled">
              <span class="os-menu-icon" />Users, Contacts, Groups, and Computers as containers
            </div>
            <div class="os-menu-row disabled"><span class="os-menu-icon" />Advanced Features</div>
            <div class="os-menu-row disabled"><span class="os-menu-icon" />Filter Options…</div>
            <div class="os-menu-separator" />
            <div class="os-menu-row disabled"><span class="os-menu-icon" />Customize…</div>
          </div>
        </div>
        <div
          class="os-menu-item"
          :class="{ open: openMenu === 'help' }"
          @click="toggleMenu('help')"
        >
          <span class="os-menu-underline">H</span>elp
          <div v-if="openMenu === 'help'" class="os-menu-dropdown">
            <div class="os-menu-row disabled"><span class="os-menu-icon" />Help Topics</div>
            <div class="os-menu-separator" />
            <div class="os-menu-row" @click="onMenuItem(() => store.openDialog({ kind: 'about' }))">
              <span class="os-menu-icon"><WinIcon name="help" :size="14" /></span>
              <span>About Active Directory Users and Computers</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ============ Toolbar ============ -->
      <div class="os-toolbar">
        <button class="os-tool-btn" type="button" disabled title="Back">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path
              d="M10 3 L4 8 L10 13"
              fill="none"
              stroke="#1d4f8c"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button class="os-tool-btn" type="button" disabled title="Forward">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path
              d="M6 3 L12 8 L6 13"
              fill="none"
              stroke="#1d4f8c"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <div class="os-tool-separator" />
        <button class="os-tool-btn" type="button" disabled title="Up one level">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path
              d="M8 12 L8 4 M4 8 L8 4 L12 8"
              fill="none"
              stroke="#1d4f8c"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button class="os-tool-btn" type="button" title="Show/Hide Console Tree" disabled>
          <svg viewBox="0 0 16 16" width="14" height="14">
            <rect x="1.5" y="2.5" width="5" height="11" fill="none" stroke="#1d4f8c" />
            <rect x="6.5" y="2.5" width="8" height="11" fill="none" stroke="#1d4f8c" />
          </svg>
        </button>
        <div class="os-tool-separator" />
        <button class="os-tool-btn" type="button" title="Refresh" @click="store.bumpData()">
          <WinIcon name="refresh" :size="14" />
        </button>
        <button class="os-tool-btn" type="button" title="Export List…" disabled>
          <svg viewBox="0 0 16 16" width="14" height="14">
            <rect x="2" y="2" width="9" height="11" fill="#fff" stroke="#1d4f8c" />
            <line x1="3.5" y1="5" x2="9.5" y2="5" stroke="#3a78c2" />
            <line x1="3.5" y1="7" x2="9.5" y2="7" stroke="#5a5a5a" />
            <line x1="3.5" y1="9" x2="9.5" y2="9" stroke="#5a5a5a" />
            <line x1="3.5" y1="11" x2="7" y2="11" stroke="#5a5a5a" />
            <path d="M11 7 L15 9 L11 11 Z" fill="#1d4f8c" />
          </svg>
        </button>
        <div class="os-tool-separator" />
        <button class="os-tool-btn" type="button" title="Properties" disabled>
          <WinIcon name="properties" :size="14" />
        </button>
        <button class="os-tool-btn" type="button" title="Help" disabled>
          <WinIcon name="help" :size="14" />
        </button>
        <div class="os-tool-separator" />
        <button
          class="os-tool-btn"
          type="button"
          title="Find"
          @click="store.openDialog({ kind: 'find' })"
        >
          <WinIcon name="find" :size="14" />
        </button>
        <button class="os-tool-btn" type="button" title="New User" disabled>
          <WinIcon name="newuser" :size="14" />
        </button>
        <button class="os-tool-btn" type="button" title="New Group" disabled>
          <WinIcon name="newgroup" :size="14" />
        </button>
        <button class="os-tool-btn" type="button" title="New Computer" disabled>
          <WinIcon name="newcomputer" :size="14" />
        </button>
      </div>

      <!-- ============ Body ============ -->
      <div class="os-body">
        <OuTreePane />
        <div class="os-splitter" @mousedown.prevent="startResize" />
        <ContentsListPane />
      </div>

      <!-- ============ Status bar ============ -->
      <div class="os-statusbar">
        <div class="os-statusbar-section" :title="statusLeft">{{ statusLeft }}</div>
        <div class="os-statusbar-section" :title="statusRight">{{ statusRight }}</div>
      </div>
    </div>

    <!-- Dialogs (mounted in the same root so Toast renders on top) -->
    <Toast position="top-right" />

    <!-- Every open dialog is a free-floating window in the windows[]
         list. Each iteration renders its own component; the v-for
         key is the stable window id so position/scroll state survives
         re-orderings of the array. -->
    <template v-for="w in store.windows" :key="w.id">
      <UserPropertiesDialog
        v-if="w.dialog.kind === 'user-properties'"
        :window-id="w.id"
        :id="w.dialog.id"
        @close="store.closeWindow(w.id)"
      />
      <GroupPropertiesDialog
        v-else-if="w.dialog.kind === 'group-properties'"
        :window-id="w.id"
        :id="w.dialog.id"
        @close="store.closeWindow(w.id)"
      />
      <ComputerPropertiesDialog
        v-else-if="w.dialog.kind === 'computer-properties'"
        :window-id="w.id"
        :id="w.dialog.id"
        @close="store.closeWindow(w.id)"
      />
      <ResetPasswordDialog
        v-else-if="w.dialog.kind === 'reset-password'"
        :window-id="w.id"
        :id="w.dialog.id"
        :sam-account-name="w.dialog.samAccountName"
        @close="store.closeWindow(w.id)"
      />
      <MoveDialog
        v-else-if="w.dialog.kind === 'move'"
        :window-id="w.id"
        :object-kind="w.dialog.objectKind"
        :id="w.dialog.id"
        :label="w.dialog.label"
        @close="store.closeWindow(w.id)"
      />
      <AddToGroupDialog
        v-else-if="w.dialog.kind === 'add-to-group'"
        :window-id="w.id"
        :user-id="w.dialog.userId"
        :user-label="w.dialog.userLabel"
        @close="store.closeWindow(w.id)"
      />
      <ConfirmDialog
        v-else-if="w.dialog.kind === 'confirm'"
        :window-id="w.id"
        :title="w.dialog.title"
        :message="w.dialog.message"
        :ok-label="w.dialog.okLabel"
        :destructive="w.dialog.destructive"
        :on-ok="w.dialog.onOk"
        @close="store.closeWindow(w.id)"
      />
      <FindDialog
        v-else-if="w.dialog.kind === 'find'"
        :window-id="w.id"
        @close="store.closeWindow(w.id)"
      />
      <AboutDialog
        v-else-if="w.dialog.kind === 'about'"
        :window-id="w.id"
        @close="store.closeWindow(w.id)"
      />
    </template>
  </div>
</template>
