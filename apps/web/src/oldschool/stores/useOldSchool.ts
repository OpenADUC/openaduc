// SPDX-License-Identifier: BUSL-1.1
// Pinia store for the Old School MMC: which container is selected in
// the tree, which row (if any) is the active selection in the list
// view, and the open set of free-floating dialog windows. Each window
// owns its own position / size / z-index — opening another dialog
// (e.g. an Add-to-Group picker from inside Properties) pushes a new
// window without closing the one underneath, mirroring how operators
// like to pull up two users side-by-side in the real console.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export type SelectedKind = 'root' | 'savedQueries' | 'domain' | 'ou' | 'container' | 'builtin';

export interface SelectedNode {
  kind: SelectedKind;
  /** Distinguished name; null for the synthetic root and savedQueries. */
  dn: string | null;
  /** Display label rendered in the address bar / status bar. */
  label: string;
}

export type DialogSpec =
  | { kind: 'user-properties'; id: string }
  | { kind: 'group-properties'; id: string }
  | { kind: 'computer-properties'; id: string }
  | { kind: 'reset-password'; id: string; samAccountName: string }
  | { kind: 'move'; objectKind: 'user' | 'group' | 'computer'; id: string; label: string }
  | { kind: 'add-to-group'; userId: string; userLabel: string }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      okLabel?: string;
      destructive?: boolean;
      onOk: () => void | Promise<void>;
    }
  | { kind: 'about' }
  | { kind: 'find' };

/** Backwards-compatible alias for the original union name. */
export type OpenDialog = DialogSpec | null;

export interface DialogWindow {
  id: number;
  dialog: DialogSpec;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

export interface SelectedRow {
  kind: 'user' | 'group' | 'computer' | 'gpo';
  id: string;
  /** Friendly label used by status bar / context menu headers. */
  label: string;
}

/**
 * Reasonable default dimensions for each dialog kind. Roughly matches
 * the proportions of the real MMC counterparts: Properties dialogs are
 * tall enough to render the General/Account tabs without scroll, the
 * pickers are wider, and Confirm is a tight little prompt.
 */
function defaultSizeFor(kind: DialogSpec['kind']): { width: number; height: number } {
  switch (kind) {
    case 'user-properties':
    case 'group-properties':
    case 'computer-properties':
      return { width: 540, height: 560 };
    case 'reset-password':
      return { width: 440, height: 340 };
    case 'move':
      return { width: 460, height: 500 };
    case 'add-to-group':
      return { width: 520, height: 480 };
    case 'find':
      return { width: 580, height: 500 };
    case 'confirm':
      return { width: 420, height: 220 };
    case 'about':
      return { width: 460, height: 260 };
  }
}

export const useOldSchool = defineStore('oldSchool', () => {
  // Synthetic root selected on mount. The tree pane resolves the
  // domain row as soon as the OU list loads and selects it.
  const selectedNode = ref<SelectedNode>({
    kind: 'root',
    dn: null,
    label: 'Active Directory Users and Computers',
  });

  const selectedRows = ref<SelectedRow[]>([]);

  // Every open dialog renders as a free-floating window. The topmost
  // (highest z) is the focused one; clicking on any window raises it.
  const windows = ref<DialogWindow[]>([]);
  let nextWindowId = 1;
  let nextZ = 1000;

  // Bumped each time a mutation succeeds. Panes watch this to refresh
  // their own data (instead of plumbing event emitters everywhere).
  const dataVersion = ref(0);

  function selectNode(n: SelectedNode): void {
    selectedNode.value = n;
    selectedRows.value = [];
  }

  function setSelection(rows: SelectedRow[]): void {
    selectedRows.value = rows;
  }

  /**
   * Open a new floating dialog window. Each call adds a new window
   * even if a dialog of the same kind is already open — that's the
   * whole point of the multi-window experience. The new window is
   * placed at a small cascading offset from the existing top window
   * (or from the viewport's quarter-point when nothing else is
   * open) so back-to-back opens don't perfectly overlap.
   */
  function openDialog(d: OpenDialog): void {
    if (!d) return;
    const size = defaultSizeFor(d.kind);
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

    // Find the topmost existing window to cascade from.
    const top = [...windows.value].sort((a, b) => b.z - a.z)[0];
    let x: number;
    let y: number;
    if (top) {
      x = top.x + 28;
      y = top.y + 28;
    } else {
      x = Math.max(40, Math.floor(vw / 2 - size.width / 2));
      y = Math.max(40, Math.floor(vh / 2 - size.height / 2) - 40);
    }
    // Clamp so the titlebar stays visible inside the viewport.
    x = Math.max(8, Math.min(x, vw - 120));
    y = Math.max(8, Math.min(y, vh - 80));

    const w: DialogWindow = {
      id: nextWindowId++,
      dialog: d,
      x,
      y,
      width: size.width,
      height: size.height,
      z: ++nextZ,
    };
    windows.value = [...windows.value, w];
  }

  function closeWindow(id: number): void {
    windows.value = windows.value.filter((w) => w.id !== id);
  }

  function focusWindow(id: number): void {
    const idx = windows.value.findIndex((w) => w.id === id);
    if (idx === -1) return;
    // Only bump z when the window isn't already on top — avoids a
    // continuous "z creep" on every click-without-move.
    const max = windows.value.reduce((m, w) => Math.max(m, w.z), 0);
    if (windows.value[idx]!.z === max) return;
    const next = windows.value.slice();
    next[idx] = { ...next[idx]!, z: ++nextZ };
    windows.value = next;
  }

  function moveWindow(id: number, x: number, y: number): void {
    const idx = windows.value.findIndex((w) => w.id === id);
    if (idx === -1) return;
    const next = windows.value.slice();
    next[idx] = { ...next[idx]!, x, y };
    windows.value = next;
  }

  function resizeWindow(id: number, width: number, height: number): void {
    const idx = windows.value.findIndex((w) => w.id === id);
    if (idx === -1) return;
    const next = windows.value.slice();
    next[idx] = { ...next[idx]!, width, height };
    windows.value = next;
  }

  function bumpData(): void {
    dataVersion.value += 1;
  }

  /** True when at least one window is open — used by the keyboard
   *  shortcut handler in OldSchoolMmc to suppress its own bindings. */
  const anyDialog = computed(() => windows.value.length > 0);

  return {
    selectedNode,
    selectedRows,
    windows,
    anyDialog,
    dataVersion,
    selectNode,
    setSelection,
    openDialog,
    closeWindow,
    focusWindow,
    moveWindow,
    resizeWindow,
    bumpData,
  };
});
