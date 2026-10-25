<!-- SPDX-License-Identifier: BUSL-1.1
     Left pane: classic ADUC console tree (see consoleTree.ts for its
     rows). Selecting a container elsewhere, such as opening a sub-OU
     from the contents list, expands the tree down to it.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { pathTo, type ConsoleNode } from '../consoleTree.js';
import WinIcon from '../primitives/WinIcon.vue';
import WinContextMenu, { type CtxItem } from '../primitives/WinContextMenu.vue';
import { useAuthStore } from '../../stores/auth.js';

const store = useOldSchool();
const auth = useAuthStore();

const tree = computed(() => store.consoleTree);
const loading = computed(() => store.treeLoading);
const errorMsg = computed(() => store.treeError);
const loadTree = (): Promise<void> => store.loadTree();

// --- Expansion --------------------------------------------------------
const expanded = ref<Set<string>>(new Set());

watch(
  tree,
  (next) => {
    if (next.length === 0) return;
    // First load: auto-expand Saved Queries (no-op) and the domain row so
    // operators see the container set immediately.
    if (expanded.value.size === 0) {
      const domain = next.find((r) => r.kind === 'domain');
      if (domain) {
        expanded.value.add(domain.key);
        // Also pre-select the domain row so the right pane has something
        // meaningful to render.
        store.selectNode({ kind: 'domain', dn: domain.dn, label: domain.label });
      }
    }
  },
  { immediate: false },
);

// Keep the selected container in view, wherever it was selected from.
watch(
  () => [store.selectedNode.dn, tree.value] as const,
  ([dn, rows]) => {
    const ancestors = dn ? pathTo(rows, dn)?.slice(0, -1) : undefined;
    if (!ancestors?.some((n) => !expanded.value.has(n.key))) return;
    expanded.value = new Set([...expanded.value, ...ancestors.map((n) => n.key)]);
  },
);

function toggle(row: ConsoleNode): void {
  const set = new Set(expanded.value);
  if (set.has(row.key)) set.delete(row.key);
  else set.add(row.key);
  expanded.value = set;
}

interface VisibleRow extends ConsoleNode {
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

function flatten(rows: ConsoleNode[], depth = 0, out: VisibleRow[] = []): VisibleRow[] {
  for (const r of rows) {
    const hasChildren = r.children.length > 0;
    const isExpanded = expanded.value.has(r.key);
    out.push({ ...r, depth, hasChildren, isExpanded });
    if (isExpanded && hasChildren) flatten(r.children, depth + 1, out);
  }
  return out;
}

const visible = computed<VisibleRow[]>(() => flatten(tree.value));

function select(row: ConsoleNode): void {
  store.selectNode({ kind: row.kind, dn: row.dn, label: row.label });
}

function onDoubleClick(row: VisibleRow): void {
  if (row.hasChildren) toggle(row);
  select(row);
}

// --- Context menu -----------------------------------------------------
const ctx = ref<{ x: number; y: number; items: CtxItem[] } | null>(null);

function onContext(row: VisibleRow, e: MouseEvent): void {
  e.preventDefault();
  select(row);
  const items: CtxItem[] = [];
  if (row.kind === 'ou' || row.kind === 'container' || row.kind === 'domain') {
    items.push(
      {
        kind: 'header',
        label: 'New',
      },
      row.kind === 'ou' && auth.hasCapability('write:user.create')
        ? {
            label: 'User…',
            icon: 'newuser',
            onSelect: () => store.openDialog({ kind: 'new-user', parentDn: row.dn! }),
          }
        : { label: 'User…', icon: 'newuser', disabled: true },
      row.kind === 'ou' && auth.hasCapability('write:group.create')
        ? {
            label: 'Group…',
            icon: 'newgroup',
            onSelect: () => store.openDialog({ kind: 'new-group', parentDn: row.dn! }),
          }
        : { label: 'Group…', icon: 'newgroup', disabled: true },
      { label: 'Computer…', icon: 'newcomputer', disabled: true },
      { label: 'Organizational Unit…', icon: 'newou', disabled: true },
      { kind: 'separator' },
    );
  }
  items.push(
    {
      label: 'Refresh',
      icon: 'refresh',
      onSelect: () => loadTree(),
    },
    {
      label: 'Find…',
      icon: 'find',
      onSelect: () => store.openDialog({ kind: 'find' }),
    },
    { kind: 'separator' },
    {
      label: 'Properties',
      icon: 'properties',
      bold: true,
      disabled: row.kind !== 'ou',
      onSelect: () => {
        /* OU properties dialog is not implemented yet */
      },
    },
  );
  ctx.value = { x: e.clientX, y: e.clientY, items };
}

watch(
  () => store.dataVersion,
  () => loadTree(),
);

onMounted(loadTree);
onUnmounted(() => {
  ctx.value = null;
});

const isSelected = (row: VisibleRow): boolean =>
  store.selectedNode.dn === row.dn ||
  (row.kind === 'savedQueries' && store.selectedNode.kind === 'savedQueries') ||
  (row.kind === 'root' && store.selectedNode.kind === 'root');
</script>

<template>
  <div class="os-tree-pane">
    <div class="os-pane-header">Console Root</div>
    <div class="os-tree" role="tree">
      <div v-if="loading && visible.length === 0" style="padding: 8px">Loading…</div>
      <div v-else-if="errorMsg" class="os-error" style="padding: 8px">
        {{ errorMsg }}
      </div>
      <div
        v-for="row in visible"
        :key="row.key"
        class="os-tree-node"
        :class="{ selected: isSelected(row) }"
        role="treeitem"
        :aria-expanded="row.hasChildren ? row.isExpanded : undefined"
        :aria-selected="isSelected(row)"
        :style="{ paddingLeft: `${row.depth * 16 + 4}px` }"
        @click="select(row)"
        @dblclick="onDoubleClick(row)"
        @contextmenu="onContext(row, $event)"
      >
        <span class="os-tree-expander" @click.stop="row.hasChildren ? toggle(row) : null">
          <template v-if="row.hasChildren">{{ row.isExpanded ? '▾' : '▸' }}</template>
        </span>
        <span class="os-tree-icon">
          <WinIcon :name="row.icon as any" :size="14" />
        </span>
        <span class="os-tree-label">{{ row.label }}</span>
      </div>
    </div>
    <WinContextMenu v-if="ctx" :x="ctx.x" :y="ctx.y" :items="ctx.items" @close="ctx = null" />
  </div>
</template>
