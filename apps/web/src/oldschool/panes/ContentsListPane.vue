<!-- SPDX-License-Identifier: BUSL-1.1
     Right pane: classic ADUC list view.

     Renders the contents of whatever container is selected in the tree:
     its sub-OUs and containers first, as ADUC lists them, then its
     objects. Columns mirror ADUC's default Users-in-OU view: Name | Type |
     Description. Header click toggles sort direction; row click
     selects; double-click opens a container or an object's Properties;
     right-click pops the context menu with the canonical action list.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useOuContents } from '../../design/composables/useOuContents.js';
import { useOldSchool, type SelectedKind, type SelectedRow } from '../stores/useOldSchool.js';
import { pathTo, type ConsoleNode } from '../consoleTree.js';
import { useAuthStore } from '../../stores/auth.js';
import { useToast } from 'primevue/usetoast';
import { undoable } from '../../design/feedback/undoToast.js';
import WinIcon from '../primitives/WinIcon.vue';
import WinContextMenu, { type CtxItem } from '../primitives/WinContextMenu.vue';
import {
  useAccountActions,
  type AccountAction,
  type AccountActionFailure,
} from '../../design/composables/useAccountActions.js';
import type { UndoOffer } from '../../design/lib/undoableWrite.js';

const store = useOldSchool();
const auth = useAuthStore();
const toast = useToast();

const {
  contents,
  loading,
  error: errorMsg,
  load: loadContents,
  clear: clearContents,
} = useOuContents();

// Rebuild the row set whenever the selected container changes or a
// mutation bumps the data version (so changes made from a Properties
// dialog flow back into the list).
watch(
  () => [store.selectedNode.dn, store.dataVersion] as const,
  ([dn]) => {
    if (typeof dn === 'string' && dn.length > 0) loadContents(dn);
    else clearContents();
  },
  { immediate: true },
);

// --- Row model --------------------------------------------------------
//
// Flatten child containers and users/groups/computers into a single
// Row[] so the table can sort across them. The Type column uses the
// labels MMC does.

interface Row {
  kind: 'user' | 'group' | 'computer' | 'container';
  id: string;
  name: string;
  type: string;
  description: string;
  icon: string;
  /** Optional sub-state used for sort + status bar. */
  disabled?: boolean;
  locked?: boolean;
  /** A domain controller or critical computer, which OpenADUC won't disable, reset or move. */
  protected?: boolean;
  /** The tree's node, for a container. */
  node?: ConsoleNode;
}

const CONTAINER_TYPES: Partial<Record<SelectedKind, string>> = {
  ou: 'Organizational Unit',
  container: 'Container',
  builtin: 'builtinDomain',
};

const childContainers = computed<ConsoleNode[]>(() => {
  const dn = store.selectedNode.dn;
  return (dn ? pathTo(store.consoleTree, dn)?.at(-1)?.children : undefined) ?? [];
});

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  for (const n of childContainers.value) {
    out.push({
      kind: 'container',
      id: n.key,
      name: n.label,
      type: CONTAINER_TYPES[n.kind] ?? 'Container',
      description: n.description ?? '',
      icon: n.icon,
      node: n,
    });
  }
  for (const u of contents.value.users) {
    out.push({
      kind: 'user',
      id: u.id,
      name: u.displayName || u.samAccountName,
      type: 'User',
      description: u.description ?? '',
      icon: u.locked ? 'user-locked' : u.enabled ? 'user' : 'user-disabled',
      disabled: !u.enabled,
      locked: u.locked,
    });
  }
  for (const g of contents.value.groups) {
    out.push({
      kind: 'group',
      id: g.id,
      name: g.name ?? g.samAccountName ?? '(unnamed group)',
      type: 'Security Group',
      description: g.description ?? '',
      icon: 'group',
    });
  }
  for (const c of contents.value.computers) {
    out.push({
      kind: 'computer',
      id: c.id,
      name: c.name ?? '(unnamed)',
      type: 'Computer',
      description: c.description ?? '',
      icon: c.enabled ? 'computer' : 'computer-disabled',
      disabled: !c.enabled,
      protected: c.writeBlock !== null,
    });
  }
  return out;
});

// --- Sort -------------------------------------------------------------
type SortKey = 'name' | 'type' | 'description';
const sortKey = ref<SortKey>('name');
const sortDir = ref<'asc' | 'desc'>('asc');

const sorted = computed<Row[]>(() => {
  // Containers stay above objects whichever way the list is sorted.
  const cmp = (a: Row, b: Row): number => {
    const ac = a.kind === 'container';
    if (ac !== (b.kind === 'container')) return ac ? -1 : 1;
    const av = (a[sortKey.value] ?? '').toString();
    const bv = (b[sortKey.value] ?? '').toString();
    const r = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
    return sortDir.value === 'asc' ? r : -r;
  };
  return [...rows.value].sort(cmp);
});

function clickHeader(k: SortKey): void {
  if (sortKey.value === k) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  else {
    sortKey.value = k;
    sortDir.value = 'asc';
  }
}

// --- Selection --------------------------------------------------------
//
// Single-select with optional ctrl/shift extension. Pinia store gets the
// authoritative list so the status bar / context menu can read it back.
const selectedIds = computed<Set<string>>(() => new Set(store.selectedRows.map((r) => r.id)));

function selectionRowFromRow(r: Row): SelectedRow {
  return { kind: r.kind, id: r.id, label: r.name };
}

function clickRow(r: Row, e: MouseEvent): void {
  if (e.ctrlKey || e.metaKey) {
    const next = [...store.selectedRows];
    const idx = next.findIndex((x) => x.id === r.id);
    if (idx >= 0) next.splice(idx, 1);
    else next.push(selectionRowFromRow(r));
    store.setSelection(next);
    return;
  }
  if (e.shiftKey && store.selectedRows.length > 0) {
    const list = sorted.value;
    const anchorId = store.selectedRows[store.selectedRows.length - 1]!.id;
    const a = list.findIndex((x) => x.id === anchorId);
    const b = list.findIndex((x) => x.id === r.id);
    if (a >= 0 && b >= 0) {
      const [from, to] = a < b ? [a, b] : [b, a];
      store.setSelection(list.slice(from, to + 1).map(selectionRowFromRow));
      return;
    }
  }
  store.setSelection([selectionRowFromRow(r)]);
}

function dblClickRow(r: Row): void {
  if (r.node) return openContainer(r.node);
  store.setSelection([selectionRowFromRow(r)]);
  openProperties(r);
}

function openContainer(n: ConsoleNode): void {
  store.selectNode({ kind: n.kind, dn: n.dn, label: n.label });
}

function openProperties(r: Row): void {
  if (r.kind === 'user') store.openDialog({ kind: 'user-properties', id: r.id });
  else if (r.kind === 'group') store.openDialog({ kind: 'group-properties', id: r.id });
  else if (r.kind === 'computer') store.openDialog({ kind: 'computer-properties', id: r.id });
}

// --- Context menu -----------------------------------------------------
const ctx = ref<{ x: number; y: number; items: CtxItem[] } | null>(null);

function buildItems(r: Row): CtxItem[] {
  if (r.kind === 'user') return userItems(r);
  if (r.kind === 'group') return groupItems(r);
  if (r.kind === 'computer') return computerItems(r);
  const node = r.node!;
  return [{ label: 'Open', bold: true, onSelect: () => openContainer(node) }];
}

const can = (capability: string): boolean => auth.hasCapability(capability);

const DONE: Record<AccountAction, (name: string) => string> = {
  enable: (name) => `Object "${name}" has been enabled.`,
  disable: (name) => `Object "${name}" has been disabled.`,
  unlock: (name) => `${name} unlocked.`,
};
// Users and computers say the same things, as ADUC does.
const feedback = {
  onDone: (action: AccountAction, r: Row, offer: UndoOffer) => {
    toast.add(undoable({ severity: 'success', summary: DONE[action](r.name), life: 2500 }, offer));
    store.bumpData();
  },
  onFailed: ({ op: { action, account }, message }: AccountActionFailure<Row>) =>
    store.reportError(`Windows cannot ${action} object ${account.name} because:\n${message}`),
};
const { runningOn, run: runAccountAction } = useAccountActions<Row>(feedback);
const { runningOn: computerRunningOn, run: runComputerAction } = useAccountActions<Row, 'computer'>(
  {
    kind: 'computer',
    ...feedback,
  },
);

function userItems(r: Row): CtxItem[] {
  const busy = runningOn(r.id) !== null;
  const items: CtxItem[] = [
    can('write:user.create')
      ? { label: 'Copy…', onSelect: () => store.openDialog({ kind: 'copy-user', id: r.id }) }
      : { label: 'Copy…', disabled: true },
  ];
  if (can('write:group.membership')) {
    items.push({
      label: 'Add to a group…',
      onSelect: () => store.openDialog({ kind: 'add-to-group', userId: r.id, userLabel: r.name }),
    });
  }
  if (can('write:user.enableDisable')) {
    items.push(
      r.disabled
        ? {
            label: 'Enable Account',
            disabled: busy,
            onSelect: () => runAccountAction('enable', r),
          }
        : {
            label: 'Disable Account',
            disabled: busy,
            onSelect: () => runAccountAction('disable', r),
          },
    );
  }
  if (can('write:user.resetPassword')) {
    items.push({
      label: 'Reset Password…',
      onSelect: () =>
        store.openDialog({ kind: 'reset-password', id: r.id, samAccountName: r.name }),
    });
  }
  if (can('write:user.unlock')) {
    items.push(
      r.locked
        ? {
            label: 'Unlock Account',
            disabled: busy,
            onSelect: () => runAccountAction('unlock', r),
          }
        : { label: 'Unlock Account', disabled: true },
    );
  }
  if (can('write:user.move')) {
    items.push({
      label: 'Move…',
      onSelect: () =>
        store.openDialog({ kind: 'move', accountKind: 'user', id: r.id, label: r.name }),
    });
  }
  const canDelete = can('write:user.delete');
  const canRename = can('write:user.rename');
  if (canDelete || canRename) items.push({ kind: 'separator' });
  if (canDelete) {
    // Delete is only offered for disabled accounts, which is also what the
    // server enforces.
    items.push(
      r.disabled
        ? {
            label: 'Delete',
            onSelect: () => store.openDialog({ kind: 'delete-user', id: r.id, label: r.name }),
          }
        : { label: 'Delete', disabled: true },
    );
  }
  if (canRename) {
    items.push({
      label: 'Rename',
      onSelect: () => store.openDialog({ kind: 'rename-user', id: r.id }),
    });
  }
  return [
    ...items,
    { kind: 'separator' },
    {
      label: 'Properties',
      icon: 'properties',
      bold: true,
      onSelect: () => openProperties(r),
    },
  ];
}

function groupItems(r: Row): CtxItem[] {
  return [
    { label: 'Add to a group…', disabled: true },
    { label: 'Move…', disabled: true },
    { label: 'Send Mail', disabled: true },
    { kind: 'separator' },
    can('write:group.delete')
      ? {
          label: 'Delete',
          onSelect: () => store.openDialog({ kind: 'delete-group', id: r.id, label: r.name }),
        }
      : { label: 'Delete', disabled: true },
    { label: 'Rename', disabled: true },
    { kind: 'separator' },
    {
      label: 'Properties',
      icon: 'properties',
      bold: true,
      onSelect: () => openProperties(r),
    },
  ];
}

function computerItems(r: Row): CtxItem[] {
  const busy = computerRunningOn(r.id) !== null;
  const items: CtxItem[] = [{ label: 'Manage', disabled: true }];
  if (can('write:computer.move')) {
    items.push({
      label: 'Move…',
      disabled: r.protected,
      onSelect: () =>
        store.openDialog({ kind: 'move', accountKind: 'computer', id: r.id, label: r.name }),
    });
  }
  const canToggle = can('write:computer.enableDisable');
  const canReset = can('write:computer.resetAccount');
  if (canToggle || canReset) items.push({ label: 'All Tasks', kind: 'header' });
  if (canToggle) {
    // Enabling a domain controller is harmless; disabling one isn't.
    items.push(
      r.disabled
        ? {
            label: 'Enable Account',
            disabled: busy,
            onSelect: () => runComputerAction('enable', r),
          }
        : {
            label: 'Disable Account',
            disabled: busy || r.protected,
            onSelect: () => runComputerAction('disable', r),
          },
    );
  }
  if (canReset) {
    items.push({
      label: 'Reset Account',
      disabled: r.protected,
      onSelect: () => store.openDialog({ kind: 'reset-computer', id: r.id, label: r.name }),
    });
  }
  return [
    ...items,
    { kind: 'separator' },
    {
      label: 'Properties',
      icon: 'properties',
      bold: true,
      onSelect: () => openProperties(r),
    },
  ];
}

function onContext(r: Row, e: MouseEvent): void {
  e.preventDefault();
  if (!selectedIds.value.has(r.id)) store.setSelection([selectionRowFromRow(r)]);
  ctx.value = { x: e.clientX, y: e.clientY, items: buildItems(r) };
}

const headerLabel = computed(() => store.selectedNode.label);
</script>

<template>
  <div class="os-list-pane">
    <div class="os-pane-header">{{ headerLabel }}</div>

    <div v-if="loading" style="padding: 8px">Loading…</div>
    <div v-else-if="errorMsg" class="os-error" style="padding: 8px">{{ errorMsg }}</div>
    <div
      v-else-if="sorted.length === 0 && store.selectedNode.kind !== 'root'"
      class="os-list-empty"
    >
      There are no items to show in this view.
    </div>
    <div
      v-else-if="store.selectedNode.kind === 'root' || store.selectedNode.kind === 'savedQueries'"
      class="os-list-empty"
    >
      Select a container in the console tree to view its contents.
    </div>

    <div v-else class="os-list">
      <table class="os-list-table">
        <thead>
          <tr>
            <th @click="clickHeader('name')">
              Name
              <span v-if="sortKey === 'name'" class="sort-marker">{{
                sortDir === 'asc' ? '▲' : '▼'
              }}</span>
            </th>
            <th style="width: 160px" @click="clickHeader('type')">
              Type
              <span v-if="sortKey === 'type'" class="sort-marker">{{
                sortDir === 'asc' ? '▲' : '▼'
              }}</span>
            </th>
            <th @click="clickHeader('description')">
              Description
              <span v-if="sortKey === 'description'" class="sort-marker">{{
                sortDir === 'asc' ? '▲' : '▼'
              }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in sorted"
            :key="`${r.kind}:${r.id}`"
            class="os-list-row"
            :class="{ selected: selectedIds.has(r.id) }"
            @click="clickRow(r, $event)"
            @dblclick="dblClickRow(r)"
            @contextmenu="onContext(r, $event)"
          >
            <td>
              <span class="os-row-icon"><WinIcon :name="r.icon as any" :size="14" /></span
              >{{ r.name }}
            </td>
            <td>{{ r.type }}</td>
            <td>{{ r.description }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <WinContextMenu v-if="ctx" :x="ctx.x" :y="ctx.y" :items="ctx.items" @close="ctx = null" />
  </div>
</template>
