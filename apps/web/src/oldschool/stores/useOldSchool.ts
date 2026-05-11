// SPDX-License-Identifier: BUSL-1.1
// Pinia store for the Old School MMC: which container is selected in
// the tree, which row (if any) is the active selection in the list
// view, and which dialog (if any) is currently open. All three pieces
// of state live here so any descendant can read/write without prop
// drilling and so dialogs can be unmounted by closing them centrally.
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

export type OpenDialog =
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
  | { kind: 'find' }
  | null;

export interface SelectedRow {
  kind: 'user' | 'group' | 'computer' | 'gpo';
  id: string;
  /** Friendly label used by status bar / context menu headers. */
  label: string;
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
  // Stack of open dialogs — the topmost renders on top of everything
  // below, matching MMC behavior where picker / confirm dialogs float on
  // top of an open Properties window. `closeDialog()` pops the top.
  const dialogStack = ref<Extract<OpenDialog, object>[]>([]);
  // Confirm dialogs use a separate channel so they float above whatever
  // primary dialog is open — closing the confirm doesn't pop the
  // underlying dialog.
  const confirmDialog = ref<Extract<OpenDialog, { kind: 'confirm' }> | null>(null);

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

  function openDialog(d: OpenDialog): void {
    if (!d) return;
    // Confirm dialogs use the overlay channel so they don't pop the
    // underlying primary dialog when dismissed.
    if (d.kind === 'confirm') {
      confirmDialog.value = d;
      return;
    }
    dialogStack.value = [...dialogStack.value, d];
  }
  function closeDialog(): void {
    if (dialogStack.value.length === 0) return;
    dialogStack.value = dialogStack.value.slice(0, -1);
  }
  function closeConfirm(): void {
    confirmDialog.value = null;
  }
  function bumpData(): void {
    dataVersion.value += 1;
  }

  // The topmost open primary dialog, if any. Use this in templates so the
  // outer container can drive `v-if` without caring how the stack works.
  const dialog = computed<OpenDialog>(() => {
    const stack = dialogStack.value;
    return stack.length > 0 ? stack[stack.length - 1]! : null;
  });

  return {
    selectedNode,
    selectedRows,
    dialog,
    dialogStack,
    confirmDialog,
    dataVersion,
    selectNode,
    setSelection,
    openDialog,
    closeDialog,
    closeConfirm,
    bumpData,
  };
});
