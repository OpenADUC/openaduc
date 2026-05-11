<!-- SPDX-License-Identifier: BUSL-1.1
     Left pane: classic ADUC console tree.

     Top-level rows (in order):
       Saved Queries (synthetic, no contents)
       <domain>          ─ resolved from the OU list's common DC= suffix
         ├─ Builtin                 (synthetic CN= container)
         ├─ Computers               (synthetic CN= container)
         ├─ Domain Controllers      (only when an OU with that name exists)
         ├─ ForeignSecurityPrincipals (synthetic)
         ├─ Managed Service Accounts (synthetic)
         ├─ Users                   (synthetic CN= container)
         └─ each top-level OU       (real, expandable)

     Synthetic containers use `CN=<name>,<domain>` DNs. The contents
     endpoint already handles any DN prefix, so the right pane fills
     in users/groups/computers normally when one is selected.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useOldSchool, type SelectedNode } from '../stores/useOldSchool.js';
import WinIcon from '../primitives/WinIcon.vue';
import WinContextMenu, { type CtxItem } from '../primitives/WinContextMenu.vue';
import type { DirectoryOu } from '@openaduc/shared';

const store = useOldSchool();

const ous = ref<DirectoryOu[]>([]);
const loading = ref(false);
const errorMsg = ref<string | null>(null);

async function loadTree(): Promise<void> {
  loading.value = true;
  errorMsg.value = null;
  try {
    const resp = await api.ous.list();
    ous.value = resp.ous;
  } catch (err) {
    errorMsg.value = err instanceof ApiError ? err.message : 'failed to load OUs';
  } finally {
    loading.value = false;
  }
}

// --- Domain DN resolution ----------------------------------------------
//
// The OU schema doesn't surface the domain DN directly, but every cached
// OU ends with the same DC=…,DC=… suffix. Walk the list, find the longest
// suffix that starts with `DC=`, and call that the domain. Falls back to a
// reasonable label when there are no OUs to inspect.
const domainDn = computed<string | null>(() => {
  if (ous.value.length === 0) return null;
  const all = ous.value.map((o) => o.distinguishedName.toLowerCase());
  const first = all[0]!;
  const parts = first.split(',');
  // Try progressively longer suffixes from the right until one is shared.
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join(',');
    if (suffix.startsWith('dc=') && all.every((d) => d.endsWith(suffix))) {
      // Re-extract from the original DN to preserve case.
      const cased = ous.value[0]!.distinguishedName;
      return cased.slice(cased.length - suffix.length);
    }
  }
  return null;
});

const domainLabel = computed<string>(() => {
  const dn = domainDn.value;
  if (!dn) return '<no directory>';
  return dn
    .split(',')
    .filter((p) => p.toLowerCase().startsWith('dc='))
    .map((p) => p.slice(3))
    .join('.');
});

// Top-level OUs = those whose parentDn is null (direct children of the
// domain root). Subsequent OUs nest by parentDn match.
interface TreeRow {
  key: string;
  label: string;
  kind: SelectedNode['kind'];
  dn: string | null;
  icon: string;
  depth: number;
  children: TreeRow[];
  expandable: boolean;
}

function makeOuRow(o: DirectoryOu, depth: number): TreeRow {
  return {
    key: o.distinguishedName,
    label: o.name,
    kind: 'ou',
    dn: o.distinguishedName,
    icon: 'ou',
    depth,
    children: [],
    expandable: true,
  };
}

const tree = computed<TreeRow[]>(() => {
  const dn = domainDn.value;
  const dLabel = domainLabel.value;
  if (!dn) {
    return [
      {
        key: 'saved-queries',
        label: 'Saved Queries',
        kind: 'savedQueries',
        dn: null,
        icon: 'savedQueries',
        depth: 0,
        children: [],
        expandable: false,
      },
    ];
  }

  // Index OUs by lowercase DN so we can wire parent→children.
  const byDn = new Map<string, TreeRow>();
  for (const o of ous.value) byDn.set(o.distinguishedName.toLowerCase(), makeOuRow(o, 0));
  const topOus: TreeRow[] = [];
  for (const o of ous.value) {
    const node = byDn.get(o.distinguishedName.toLowerCase())!;
    if (!o.parentDn || o.parentDn.toLowerCase() === dn.toLowerCase()) {
      topOus.push(node);
    } else {
      const parent = byDn.get(o.parentDn.toLowerCase());
      if (parent) {
        node.depth = parent.depth + 1;
        parent.children.push(node);
      } else {
        // Orphan: parent OU was filtered/stale. Show it at the domain root.
        topOus.push(node);
      }
    }
  }

  // Walk and stamp the correct depth recursively (the assignment above
  // only handled direct children; deeper levels need a second pass).
  const stampDepth = (rows: TreeRow[], d: number): void => {
    for (const r of rows) {
      r.depth = d;
      stampDepth(r.children, d + 1);
    }
  };
  // Synthetic containers always live directly under the domain row.
  const containers: TreeRow[] = [
    {
      key: `CN=Builtin,${dn}`,
      label: 'Builtin',
      kind: 'builtin',
      dn: `CN=Builtin,${dn}`,
      icon: 'builtin',
      depth: 1,
      children: [],
      expandable: false,
    },
    {
      key: `CN=Computers,${dn}`,
      label: 'Computers',
      kind: 'container',
      dn: `CN=Computers,${dn}`,
      icon: 'container',
      depth: 1,
      children: [],
      expandable: false,
    },
    {
      key: `CN=ForeignSecurityPrincipals,${dn}`,
      label: 'ForeignSecurityPrincipals',
      kind: 'container',
      dn: `CN=ForeignSecurityPrincipals,${dn}`,
      icon: 'container',
      depth: 1,
      children: [],
      expandable: false,
    },
    {
      key: `CN=Managed Service Accounts,${dn}`,
      label: 'Managed Service Accounts',
      kind: 'container',
      dn: `CN=Managed Service Accounts,${dn}`,
      icon: 'container',
      depth: 1,
      children: [],
      expandable: false,
    },
    {
      key: `CN=Users,${dn}`,
      label: 'Users',
      kind: 'container',
      dn: `CN=Users,${dn}`,
      icon: 'container',
      depth: 1,
      children: [],
      expandable: false,
    },
  ];

  // Merge the synthetic containers with the real top-level OUs, sorted
  // alphabetically so the tree reads like ADUC (Builtin, Computers,
  // Domain Controllers OU, ForeignSecurityPrincipals, Managed Service
  // Accounts, ...your OUs..., Users).
  const merged = [...containers, ...topOus].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true }),
  );

  // Recursive sort for OU children.
  const sortRec = (rows: TreeRow[]): void => {
    rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    for (const r of rows) sortRec(r.children);
  };
  for (const r of topOus) sortRec(r.children);

  const domain: TreeRow = {
    key: dn,
    label: dLabel,
    kind: 'domain',
    dn,
    icon: 'domain',
    depth: 0,
    children: merged,
    expandable: true,
  };
  stampDepth(domain.children, 1);

  return [
    {
      key: 'saved-queries',
      label: 'Saved Queries',
      kind: 'savedQueries',
      dn: null,
      icon: 'savedQueries',
      depth: 0,
      children: [],
      expandable: false,
    },
    domain,
  ];
});

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

function toggle(row: TreeRow): void {
  const set = new Set(expanded.value);
  if (set.has(row.key)) set.delete(row.key);
  else set.add(row.key);
  expanded.value = set;
}

interface VisibleRow extends TreeRow {
  hasChildren: boolean;
  isExpanded: boolean;
}

function flatten(rows: TreeRow[], depth = 0, out: VisibleRow[] = []): VisibleRow[] {
  for (const r of rows) {
    const hasChildren = r.children.length > 0;
    const isExpanded = expanded.value.has(r.key);
    out.push({ ...r, depth, hasChildren, isExpanded });
    if (isExpanded && hasChildren) flatten(r.children, depth + 1, out);
  }
  return out;
}

const visible = computed<VisibleRow[]>(() => flatten(tree.value));

function select(row: TreeRow): void {
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
      { label: 'User…', icon: 'newuser', disabled: true },
      { label: 'Group…', icon: 'newgroup', disabled: true },
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
