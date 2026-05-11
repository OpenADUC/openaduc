<!-- SPDX-License-Identifier: BUSL-1.1
     Right pane: classic ADUC list view.

     Renders the contents of whatever container is selected in the tree.
     Columns mirror ADUC's default Users-in-OU view: Name | Type |
     Description. Header click toggles sort direction; row click
     selects; double-click opens Properties; right-click pops the
     context menu with the canonical action list.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useOldSchool, type SelectedRow } from '../stores/useOldSchool.js';
import { useAuthStore } from '../../stores/auth.js';
import { useToast } from 'primevue/usetoast';
import WinIcon from '../primitives/WinIcon.vue';
import WinContextMenu, { type CtxItem } from '../primitives/WinContextMenu.vue';
import type { OuContentsResponse } from '@openaduc/shared';

const store = useOldSchool();
const auth = useAuthStore();
const toast = useToast();

function showToastSuccess(summary: string): void {
  toast.add({ severity: 'success', summary, life: 2500 });
}
function showToastError(err: unknown): void {
  const detail =
    err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
  toast.add({ severity: 'error', summary: 'Operation failed', detail, life: 5000 });
}

const emptyContents: OuContentsResponse = {
  users: [],
  groups: [],
  computers: [],
  linkedGroupPolicies: [],
  inheritedGroupPolicies: [],
};

const contents = ref<OuContentsResponse>({ ...emptyContents });
const loading = ref(false);
const errorMsg = ref<string | null>(null);

async function loadContents(dn: string): Promise<void> {
  loading.value = true;
  errorMsg.value = null;
  try {
    contents.value = await api.ous.contents(dn);
  } catch (err) {
    contents.value = { ...emptyContents };
    errorMsg.value = err instanceof ApiError ? err.message : 'failed to load contents';
  } finally {
    loading.value = false;
  }
}

// Rebuild the row set whenever the selected container changes or a
// mutation bumps the data version (so changes made from a Properties
// dialog flow back into the list).
watch(
  () => [store.selectedNode.dn, store.dataVersion] as const,
  ([dn]) => {
    if (typeof dn === 'string' && dn.length > 0) loadContents(dn);
    else contents.value = { ...emptyContents };
  },
  { immediate: true },
);

// --- Row model --------------------------------------------------------
//
// Flatten users/groups/computers into a single Row[] so the table can
// sort across them. The Type column reads "User" / "Security Group" /
// "Computer" — same labels MMC uses.

interface Row {
  kind: 'user' | 'group' | 'computer';
  id: string;
  name: string;
  type: string;
  description: string;
  icon: string;
  /** Optional sub-state used for sort + status bar. */
  disabled?: boolean;
  locked?: boolean;
}

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  for (const u of contents.value.users) {
    out.push({
      kind: 'user',
      id: u.id,
      name: u.displayName || u.samAccountName,
      type: 'User',
      description: u.email ?? '',
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
      description: c.operatingSystem ?? c.dnsHostName ?? '',
      icon: c.enabled ? 'computer' : 'computer-disabled',
      disabled: !c.enabled,
    });
  }
  return out;
});

// --- Sort -------------------------------------------------------------
type SortKey = 'name' | 'type' | 'description';
const sortKey = ref<SortKey>('name');
const sortDir = ref<'asc' | 'desc'>('asc');

const sorted = computed<Row[]>(() => {
  const cmp = (a: Row, b: Row): number => {
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
  store.setSelection([selectionRowFromRow(r)]);
  openProperties(r);
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
  return [];
}

function userItems(r: Row): CtxItem[] {
  return [
    {
      label: 'Copy…',
      disabled: true,
      onSelect: () => undefined,
    },
    {
      label: 'Add to a group…',
      onSelect: () => store.openDialog({ kind: 'add-to-group', userId: r.id, userLabel: r.name }),
    },
    r.disabled
      ? {
          label: 'Enable Account',
          onSelect: () =>
            auth.requireEdit(async () => {
              try {
                await api.users.enable(r.id);
                showToastSuccess(`Object "${r.name}" has been enabled.`);
                store.bumpData();
              } catch (err) {
                showToastError(err);
              }
            }, 'Enabling a user account requires step-up authentication.'),
        }
      : {
          label: 'Disable Account',
          onSelect: () =>
            auth.requireEdit(async () => {
              try {
                await api.users.disable(r.id);
                showToastSuccess(`Object "${r.name}" has been disabled.`);
                store.bumpData();
              } catch (err) {
                showToastError(err);
              }
            }, 'Disabling a user account requires step-up authentication.'),
        },
    {
      label: 'Reset Password…',
      onSelect: () =>
        store.openDialog({ kind: 'reset-password', id: r.id, samAccountName: r.name }),
    },
    r.locked
      ? {
          label: 'Unlock Account',
          onSelect: () =>
            auth.requireEdit(async () => {
              try {
                await api.users.unlock(r.id);
                showToastSuccess(`${r.name} unlocked.`);
                store.bumpData();
              } catch (err) {
                showToastError(err);
              }
            }, 'Unlocking a user account requires step-up authentication.'),
        }
      : { label: 'Unlock Account', disabled: true },
    {
      label: 'Move…',
      onSelect: () =>
        store.openDialog({ kind: 'move', objectKind: 'user', id: r.id, label: r.name }),
    },
    { kind: 'separator' },
    {
      label: 'Delete',
      disabled: true,
    },
    {
      label: 'Rename',
      disabled: true,
    },
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
    {
      label: 'Move…',
      onSelect: () =>
        store.openDialog({ kind: 'move', objectKind: 'group', id: r.id, label: r.name }),
    },
    { label: 'Send Mail', disabled: true },
    { kind: 'separator' },
    { label: 'Delete', disabled: true },
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
  return [
    {
      label: 'Manage',
      disabled: true,
    },
    {
      label: 'Move…',
      onSelect: () =>
        store.openDialog({ kind: 'move', objectKind: 'computer', id: r.id, label: r.name }),
    },
    {
      label: 'All Tasks',
      kind: 'header',
    },
    { label: 'Disable Account', disabled: r.disabled },
    { label: 'Enable Account', disabled: !r.disabled },
    { label: 'Reset Account', disabled: true },
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
