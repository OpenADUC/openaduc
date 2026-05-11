<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Tree from 'primevue/tree';
import Button from 'primevue/button';
import ContextMenu from 'primevue/contextmenu';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import type { TreeNode } from 'primevue/treenode';
import type { MenuItem } from 'primevue/menuitem';
import Card from '../design/primitives/Card.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import PageHeader from '../design/primitives/PageHeader.vue';
import { api } from '../api/index.js';
import { ApiError } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';
import type { DirectoryOu, OuContentsResponse } from '@openaduc/shared';

const auth = useAuthStore();
const toast = useToast();

const canCreateOu = computed(() => auth.hasCapability('write:ou.create'));
const canUpdateOu = computed(() => auth.hasCapability('write:ou.update'));
const canDeleteOu = computed(() => auth.hasCapability('write:ou.delete'));

// ---- OU tree -------------------------------------------------------------

const ous = ref<DirectoryOu[]>([]);
const loadingTree = ref(false);
const treeError = ref<string | null>(null);

// Tracks whether we've already populated `expandedKeys` once. The first
// successful tree load expands everything so the operator sees the whole
// hierarchy immediately; subsequent reloads (after a create/delete) keep
// whatever expansion state the operator has been working with so we don't
// fight their interaction.
let expandedInitialized = false;

async function loadTree(): Promise<void> {
  loadingTree.value = true;
  treeError.value = null;
  try {
    const resp = await api.ous.list();
    ous.value = resp.ous;
    if (!expandedInitialized && resp.ous.length > 0) {
      expandAll();
      expandedInitialized = true;
    }
  } catch (err) {
    treeError.value = err instanceof ApiError ? err.message : 'failed to load OUs';
  } finally {
    loadingTree.value = false;
  }
}

const treeNodes = computed<TreeNode[]>(() => {
  if (ous.value.length === 0) return [];
  const byDn = new Map<string, TreeNode & { children: TreeNode[] }>();
  for (const ou of ous.value) {
    byDn.set(ou.distinguishedName.toLowerCase(), {
      key: ou.distinguishedName,
      label: ou.name,
      // The icon is picked in the template based on expansion state — we
      // can't compute it here because that state lives only in the slot
      // props. `data.hasChildren` is the input the slot needs.
      data: {
        dn: ou.distinguishedName,
        stale: ou.stale,
        hasChildren: false,
        description: ou.description,
      },
      children: [],
    });
  }
  const roots: TreeNode[] = [];
  for (const ou of ous.value) {
    const node = byDn.get(ou.distinguishedName.toLowerCase())!;
    const parent = ou.parentDn ? byDn.get(ou.parentDn.toLowerCase()) : undefined;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  // Second pass: now that the parent/child wiring is done, flip
  // hasChildren on any node that ended up with children. Couldn't do this
  // inline above without two lookups per row.
  for (const node of byDn.values()) {
    if (node.children && node.children.length > 0) {
      (node.data as { hasChildren: boolean }).hasChildren = true;
    }
  }
  const sortRec = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
    for (const n of nodes) if (n.children) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
});

// PrimeVue Tree single-selection model: a record keyed by node `key`. We
// track the currently selected DN as a derived value so the right pane can
// react to selection changes without poking into the record everywhere.
const selectionKeys = ref<Record<string, boolean>>({});

// Tree expand state. PrimeVue v-models a `{ [key]: true }` record; an entry
// is "expanded" only when its value is truthy. Tracking this ourselves lets
// the title-bar buttons flip every node at once.
const expandedKeys = ref<Record<string, boolean>>({});
const allExpanded = computed(() => {
  const total = ous.value.length;
  if (total === 0) return false;
  let count = 0;
  for (const k of Object.keys(expandedKeys.value)) {
    if (expandedKeys.value[k]) count++;
  }
  return count >= total;
});

function expandAll(): void {
  const next: Record<string, boolean> = {};
  for (const o of ous.value) next[o.distinguishedName] = true;
  expandedKeys.value = next;
}

function collapseAll(): void {
  expandedKeys.value = {};
}

/**
 * Pick the folder icon for a tree node. PrimeIcons doesn't ship a
 * solid/outlined pair, so the visual contrast between "has children" and
 * "leaf" comes from CSS classes (.has-children vs .leaf in the slot
 * template). The icon glyph itself just toggles between closed and open:
 *   - has children + collapsed → pi-folder
 *   - has children + expanded  → pi-folder-open
 *   - leaf                     → pi-folder-open (always shown "open" so the
 *                                operator can tell at a glance there's
 *                                nothing to drill into)
 */
function iconForNode(node: TreeNode, expanded: boolean | undefined): string {
  const hasChildren = node.data?.hasChildren === true;
  if (!hasChildren) return 'pi pi-folder-open';
  return expanded ? 'pi pi-folder-open' : 'pi pi-folder';
}
const selectedDn = computed<string | null>(() => {
  const keys = Object.keys(selectionKeys.value).filter((k) => selectionKeys.value[k]);
  return keys[0] ?? null;
});

const selectedOu = computed<DirectoryOu | null>(() => {
  const dn = selectedDn.value;
  if (!dn) return null;
  return ous.value.find((o) => o.distinguishedName.toLowerCase() === dn.toLowerCase()) ?? null;
});

// ---- OU contents ---------------------------------------------------------

type TabId = 'all' | 'users' | 'groups' | 'computers' | 'policies';
const activeTab = ref<TabId>('all');

const emptyContents: OuContentsResponse = {
  users: [],
  groups: [],
  computers: [],
  linkedGroupPolicies: [],
  inheritedGroupPolicies: [],
};
const contents = ref<OuContentsResponse>({ ...emptyContents });
const loadingContents = ref(false);
const contentsError = ref<string | null>(null);

const totalGpoCount = computed(
  () => contents.value.linkedGroupPolicies.length + contents.value.inheritedGroupPolicies.length,
);

async function loadContents(dn: string): Promise<void> {
  loadingContents.value = true;
  contentsError.value = null;
  try {
    contents.value = await api.ous.contents(dn);
  } catch (err) {
    contents.value = { ...emptyContents };
    contentsError.value = err instanceof ApiError ? err.message : 'failed to load OU contents';
  } finally {
    loadingContents.value = false;
  }
}

watch(selectedDn, (dn) => {
  if (dn) loadContents(dn);
  else contents.value = { ...emptyContents };
});

onMounted(loadTree);

// ---- Context menu --------------------------------------------------------

// PrimeVue's ContextMenu API works via a template ref + show(event). We
// stash both the right-clicked OU and a freshly-fetched child-count snapshot
// so the menu items can show "Delete OU (3 items inside)" rather than a
// silent disabled state.
const ctxMenu = ref<InstanceType<typeof ContextMenu> | null>(null);
const ctxOu = ref<DirectoryOu | null>(null);
const ctxCounts = ref<{ users: number; groups: number; ous: number } | null>(null);
const ctxCountsLoading = ref(false);

const ctxHasChildren = computed(() => {
  const c = ctxCounts.value;
  if (!c) return null; // unknown — treat as "loading"
  return c.users + c.groups + c.ous > 0;
});

const ctxItems = computed<MenuItem[]>(() => {
  const ou = ctxOu.value;
  if (!ou) return [];
  const items: MenuItem[] = [];
  // Write actions stay clickable whether or not edit mode is on —
  // `auth.requireEdit` pops the StepUpDialog for an unauthenticated operator
  // and auto-fires the action after they authenticate.
  if (canUpdateOu.value) {
    items.push({
      label: 'Edit description',
      icon: 'pi pi-pencil',
      command: () => auth.requireEdit(() => openEditDialog(ou)),
      tooltip: 'Edit this OU’s description (rename is not supported).',
    });
  }
  if (canCreateOu.value) {
    items.push({
      label: 'Add child OU',
      icon: 'pi pi-folder-plus',
      command: () => auth.requireEdit(() => openCreateDialog(ou)),
      tooltip: 'Create a new organizational unit under this one.',
    });
  }
  if (canDeleteOu.value) {
    const counts = ctxCounts.value;
    const childTip = counts
      ? counts.users + counts.groups + counts.ous === 0
        ? 'Permanently remove this OU.'
        : `Cannot delete: contains ${counts.users} user(s), ${counts.groups} group(s), ${counts.ous} sub-OU(s).`
      : ctxCountsLoading.value
        ? 'Checking for children…'
        : 'Permanently remove this OU.';
    items.push({
      label: 'Delete OU',
      icon: 'pi pi-trash',
      // Disabled only if children are unknown (still fetching) or children
      // are present. Edit-mode is handled at click time by requireEdit.
      disabled: ctxHasChildren.value !== false,
      command: () => auth.requireEdit(() => openDeleteDialog(ou)),
      tooltip: childTip,
    });
  }

  // Description row at the bottom — only shown when the OU has one. Marked
  // `kind: 'info'` so the slot template renders it as a non-clickable
  // descriptive block instead of a menu action. Add a separator above so
  // it visually detaches from the actions.
  const desc = ou.description?.trim();
  if (desc && items.length > 0) {
    items.push({ separator: true });
    items.push({
      // No `command` — this row is informational. The slot template
      // recognizes `kind: 'info'` and renders accordingly.
      label: desc,
      kind: 'info',
      icon: 'pi pi-info-circle',
    });
  }

  return items;
});

async function onTreeNodeContext(event: MouseEvent, node: TreeNode): Promise<void> {
  if (!canCreateOu.value && !canUpdateOu.value && !canDeleteOu.value) return;
  event.preventDefault();
  event.stopPropagation();
  const dn = node.data?.dn as string | undefined;
  if (!dn) return;
  const ou = ous.value.find((o) => o.distinguishedName.toLowerCase() === dn.toLowerCase());
  if (!ou) return;
  ctxOu.value = ou;
  ctxCounts.value = null;
  ctxCountsLoading.value = true;

  // Show the menu immediately (it'll have the Delete item disabled while
  // the counts are loading). Then fetch counts and refresh the menu state.
  ctxMenu.value?.show(event);

  try {
    // Direct sub-OUs we already know — count from the cached list.
    const subOus = ous.value.filter((o) => o.parentDn?.toLowerCase() === dn.toLowerCase()).length;
    const contentsResp = await api.ous.contents(dn);
    ctxCounts.value = {
      users: contentsResp.users.length,
      groups: contentsResp.groups.length,
      ous: subOus,
    };
  } catch {
    // If the count fetch fails, keep Delete disabled — we'd rather
    // refuse a possibly-destructive click than green-light it on stale data.
    ctxCounts.value = null;
  } finally {
    ctxCountsLoading.value = false;
  }
}

// ---- Create OU dialog ----------------------------------------------------

const createDialogOpen = ref(false);
const createParent = ref<DirectoryOu | null>(null);
const createDraft = ref({ name: '', description: '' });
const createSubmitting = ref(false);
const createError = ref<string | null>(null);

function openCreateDialog(parent: DirectoryOu): void {
  createParent.value = parent;
  createDraft.value = { name: '', description: '' };
  createError.value = null;
  createDialogOpen.value = true;
}

const createPreviewDn = computed(() => {
  const parent = createParent.value;
  const name = createDraft.value.name.trim();
  if (!parent || !name) return '';
  return `OU=${name},${parent.distinguishedName}`;
});

async function onCreateSubmit(): Promise<void> {
  if (!createParent.value) return;
  const name = createDraft.value.name.trim();
  if (!name) {
    createError.value = 'name is required';
    return;
  }
  // Same regex the server enforces — give the operator immediate feedback
  // rather than a 400 round-trip.
  if (!/^[^,=+<>#;\\" ]+$/.test(name) || name.startsWith('#')) {
    createError.value = 'name contains a reserved character';
    return;
  }
  createError.value = null;
  createSubmitting.value = true;
  try {
    const description = createDraft.value.description.trim();
    await api.ous.create({
      parentDn: createParent.value.distinguishedName,
      name,
      description: description || null,
    });
    toast.add({
      severity: 'success',
      summary: 'OU created',
      detail: `${name} added under ${createParent.value.name}`,
      life: 3500,
    });
    createDialogOpen.value = false;
    await loadTree();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'step_up_required') {
      auth.stepUpPendingAction = onCreateSubmit;
      return;
    }
    createError.value = err instanceof ApiError ? err.message : 'create failed';
  } finally {
    createSubmitting.value = false;
  }
}

// ---- Edit OU dialog ------------------------------------------------------

const editDialogOpen = ref(false);
const editTarget = ref<DirectoryOu | null>(null);
const editDraft = ref({ description: '' });
const editSubmitting = ref(false);
const editError = ref<string | null>(null);

function openEditDialog(target: DirectoryOu): void {
  editTarget.value = target;
  editDraft.value = { description: target.description ?? '' };
  editError.value = null;
  editDialogOpen.value = true;
}

const editIsDirty = computed(() => {
  const target = editTarget.value;
  if (!target) return false;
  const original = (target.description ?? '').trim();
  const draft = editDraft.value.description.trim();
  return original !== draft;
});

async function onEditSubmit(): Promise<void> {
  if (!editTarget.value || !editIsDirty.value) return;
  editError.value = null;
  editSubmitting.value = true;
  try {
    const draft = editDraft.value.description.trim();
    // Send null when the operator cleared the field, which the AD provider
    // translates into a delete-attribute op. Otherwise send the trimmed
    // string for a replace.
    await api.ous.update({
      dn: editTarget.value.distinguishedName,
      patch: { description: draft.length === 0 ? null : draft },
    });
    toast.add({
      severity: 'success',
      summary: 'OU updated',
      detail: editTarget.value.name,
      life: 3000,
    });
    editDialogOpen.value = false;
    await loadTree();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'step_up_required') {
      auth.stepUpPendingAction = onEditSubmit;
      return;
    }
    editError.value = err instanceof ApiError ? err.message : 'update failed';
  } finally {
    editSubmitting.value = false;
  }
}

// ---- Delete OU dialog ----------------------------------------------------

const deleteDialogOpen = ref(false);
const deleteTarget = ref<DirectoryOu | null>(null);
const deleteSubmitting = ref(false);
const deleteError = ref<string | null>(null);

function openDeleteDialog(target: DirectoryOu): void {
  deleteTarget.value = target;
  deleteError.value = null;
  deleteDialogOpen.value = true;
}

async function onDeleteSubmit(): Promise<void> {
  if (!deleteTarget.value) return;
  deleteError.value = null;
  deleteSubmitting.value = true;
  try {
    await api.ous.delete({ dn: deleteTarget.value.distinguishedName });
    toast.add({
      severity: 'success',
      summary: 'OU deleted',
      detail: deleteTarget.value.name,
      life: 3500,
    });
    deleteDialogOpen.value = false;
    // If the deleted OU was the currently-selected one, clear selection
    // so the right pane doesn't show stale contents.
    if (
      selectedDn.value &&
      selectedDn.value.toLowerCase() === deleteTarget.value.distinguishedName.toLowerCase()
    ) {
      selectionKeys.value = {};
    }
    await loadTree();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'step_up_required') {
      auth.stepUpPendingAction = onDeleteSubmit;
      return;
    }
    deleteError.value = err instanceof ApiError ? err.message : 'delete failed';
  } finally {
    deleteSubmitting.value = false;
  }
}
</script>

<template>
  <div class="page-inner page-fill ou-browser">
    <PageHeader title="Directory structure" />

    <div class="ou-grid">
      <!-- Left: OU tree. Right-click anywhere inside the pane is intercepted
           — node-level right clicks open our context menu; everything else
           (gutters, padding, scrollbar) gets prevented so the browser's
           native menu doesn't surface on a slightly-off click. The tree
           node handler does its own stopPropagation, so this prevent only
           fires on non-node clicks. -->
      <Card class="ou-pane" @contextmenu.prevent>
        <template #head>
          <div class="pane-title">
            <h3 class="pane-h">Organizational units</h3>
            <div class="pane-title-right">
              <span v-if="ous.length > 0" class="pane-count">{{ ous.length }}</span>
              <Button
                v-if="ous.length > 0"
                :icon="allExpanded ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
                severity="secondary"
                text
                rounded
                size="small"
                :title="allExpanded ? 'Collapse all' : 'Expand all'"
                :aria-label="allExpanded ? 'Collapse all' : 'Expand all'"
                @click="allExpanded ? collapseAll() : expandAll()"
              />
            </div>
          </div>
        </template>
        <div class="pane-body">
          <div v-if="loadingTree" class="hint">Loading…</div>
          <div v-else-if="treeError" class="hint error">{{ treeError }}</div>
          <EmptyState
            v-else-if="treeNodes.length === 0"
            icon="pi pi-folder-open"
            title="No OUs cached yet"
            message="Run a directory sync to populate the OU tree."
          />
          <Tree
            v-else
            v-model:selection-keys="selectionKeys"
            v-model:expanded-keys="expandedKeys"
            :value="treeNodes"
            selection-mode="single"
            class="ou-tree"
          >
            <template #default="slotProps">
              <span
                class="tree-label"
                :class="{
                  stale: slotProps.node.data?.stale,
                  'has-children': slotProps.node.data?.hasChildren,
                  leaf: !slotProps.node.data?.hasChildren,
                }"
                :title="slotProps.node.data?.description?.trim() || slotProps.node.data?.dn"
                @contextmenu="onTreeNodeContext($event, slotProps.node)"
              >
                <i
                  class="tree-icon"
                  :class="iconForNode(slotProps.node, expandedKeys[slotProps.node.key as string])"
                />
                {{ slotProps.node.label }}
                <span v-if="slotProps.node.data?.stale" class="stale-badge">stale</span>
              </span>
            </template>
          </Tree>
        </div>
      </Card>

      <!-- Right: contents -->
      <Card class="ou-pane">
        <template #head>
          <div class="pane-title">
            <h3 class="pane-h">{{ selectedOu?.name ?? 'Select an OU' }}</h3>
          </div>
          <code v-if="selectedOu" class="dn-line">{{ selectedOu.distinguishedName }}</code>
        </template>
        <div class="pane-body">
          <EmptyState
            v-if="!selectedOu"
            icon="pi pi-folder"
            title="No OU selected"
            message="Pick an organizational unit on the left."
          />
          <div v-else-if="loadingContents" class="hint">Loading contents…</div>
          <div v-else-if="contentsError" class="hint error">{{ contentsError }}</div>
          <div v-else class="contents-tabs">
            <!-- Tab nav. Counts on every tab so the operator can scan
                 distribution without clicking through. The "All" tab is
                 first so opening an OU still shows everything at once,
                 matching the previous behavior. -->
            <nav class="ds-tabs ou-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                class="ds-tab"
                :class="{ active: activeTab === 'all' }"
                @click="activeTab = 'all'"
              >
                All
                <span class="ds-tab-count mono">{{
                  contents.users.length +
                  contents.groups.length +
                  contents.computers.length +
                  totalGpoCount
                }}</span>
              </button>
              <button
                type="button"
                role="tab"
                class="ds-tab"
                :class="{ active: activeTab === 'users' }"
                @click="activeTab = 'users'"
              >
                Users
                <span class="ds-tab-count mono">{{ contents.users.length }}</span>
              </button>
              <button
                type="button"
                role="tab"
                class="ds-tab"
                :class="{ active: activeTab === 'groups' }"
                @click="activeTab = 'groups'"
              >
                Groups
                <span class="ds-tab-count mono">{{ contents.groups.length }}</span>
              </button>
              <button
                type="button"
                role="tab"
                class="ds-tab"
                :class="{ active: activeTab === 'computers' }"
                @click="activeTab = 'computers'"
              >
                Computers
                <span class="ds-tab-count mono">{{ contents.computers.length }}</span>
              </button>
              <button
                type="button"
                role="tab"
                class="ds-tab"
                :class="{ active: activeTab === 'policies' }"
                @click="activeTab = 'policies'"
              >
                Group Policies
                <span class="ds-tab-count mono">{{ totalGpoCount }}</span>
              </button>
            </nav>

            <!-- All tab — every populated section in one scroll. Each
                 section reuses the same row markup as the dedicated tab
                 so the visuals don't drift. -->
            <div v-if="activeTab === 'all'" class="contents">
              <div
                v-if="
                  contents.users.length === 0 &&
                  contents.groups.length === 0 &&
                  contents.computers.length === 0 &&
                  totalGpoCount === 0
                "
                class="hint"
              >
                This OU has no direct users, groups, computers, or linked policies in the cache.
              </div>
              <section v-if="contents.users.length > 0" class="contents-section">
                <h2 class="section-h">Users</h2>
                <ul class="row-list">
                  <li v-for="u in contents.users" :key="u.id" class="row">
                    <RouterLink :to="`/users/${u.id}`" class="row-link">
                      <i class="pi pi-user row-icon" />
                      <span class="row-main">
                        <span class="row-name">{{ u.displayName ?? u.samAccountName }}</span>
                        <span class="row-sub">
                          {{ u.samAccountName }}
                          <span v-if="u.email"> · {{ u.email }}</span>
                        </span>
                      </span>
                      <span class="row-flags">
                        <span v-if="!u.enabled" class="flag flag-muted">disabled</span>
                        <span v-if="u.locked" class="flag flag-warn">locked</span>
                      </span>
                    </RouterLink>
                  </li>
                </ul>
              </section>
              <section v-if="contents.groups.length > 0" class="contents-section">
                <h2 class="section-h">Groups</h2>
                <ul class="row-list">
                  <li v-for="g in contents.groups" :key="g.id" class="row">
                    <RouterLink :to="`/groups/${g.id}`" class="row-link">
                      <i class="pi pi-objects-column row-icon" />
                      <span class="row-main">
                        <span class="row-name">{{ g.name ?? g.samAccountName ?? '—' }}</span>
                        <span v-if="g.description" class="row-sub">{{ g.description }}</span>
                      </span>
                    </RouterLink>
                  </li>
                </ul>
              </section>
              <section v-if="contents.computers.length > 0" class="contents-section">
                <h2 class="section-h">Computers</h2>
                <ul class="row-list">
                  <li v-for="c in contents.computers" :key="c.id" class="row">
                    <RouterLink :to="`/computers/${c.id}`" class="row-link">
                      <i class="pi pi-desktop row-icon" />
                      <span class="row-main">
                        <span class="row-name">{{ c.name ?? c.samAccountName ?? '—' }}</span>
                        <span class="row-sub">
                          <span v-if="c.dnsHostName">{{ c.dnsHostName }}</span>
                          <span v-if="c.operatingSystem"> · {{ c.operatingSystem }}</span>
                        </span>
                      </span>
                      <span class="row-flags">
                        <span v-if="!c.enabled" class="flag flag-muted">disabled</span>
                      </span>
                    </RouterLink>
                  </li>
                </ul>
              </section>
              <section v-if="contents.linkedGroupPolicies.length > 0" class="contents-section">
                <h2 class="section-h">Group Policies — linked here</h2>
                <ul class="row-list">
                  <li
                    v-for="(p, idx) in contents.linkedGroupPolicies"
                    :key="`l-${p.id}-${idx}`"
                    class="row"
                  >
                    <RouterLink :to="`/policies/groups/${p.id}`" class="row-link">
                      <i class="pi pi-shield row-icon" />
                      <span class="row-main">
                        <span class="row-name">{{ p.displayName ?? p.gpoGuid }}</span>
                        <span class="row-sub mono">{{ p.gpoGuid }}</span>
                      </span>
                      <span class="row-flags">
                        <span v-if="!p.enabled" class="flag flag-muted">link disabled</span>
                        <span v-if="p.enforced" class="flag flag-warn">enforced</span>
                      </span>
                    </RouterLink>
                  </li>
                </ul>
              </section>
              <section v-if="contents.inheritedGroupPolicies.length > 0" class="contents-section">
                <h2 class="section-h">Group Policies — inherited</h2>
                <ul class="row-list">
                  <li
                    v-for="(p, idx) in contents.inheritedGroupPolicies"
                    :key="`i-${p.id}-${idx}`"
                    class="row"
                  >
                    <RouterLink :to="`/policies/groups/${p.id}`" class="row-link">
                      <i class="pi pi-shield row-icon" />
                      <span class="row-main">
                        <span class="row-name">{{ p.displayName ?? p.gpoGuid }}</span>
                        <span class="row-sub">
                          from <strong>{{ p.scopeName ?? p.scopeDn }}</strong>
                        </span>
                      </span>
                      <span class="row-flags">
                        <span v-if="!p.enabled" class="flag flag-muted">link disabled</span>
                        <span v-if="p.enforced" class="flag flag-warn">enforced</span>
                      </span>
                    </RouterLink>
                  </li>
                </ul>
              </section>
            </div>

            <!-- Users -->
            <div v-else-if="activeTab === 'users'" class="contents">
              <div v-if="contents.users.length === 0" class="hint">
                No users live directly in this OU.
              </div>
              <ul v-else class="row-list">
                <li v-for="u in contents.users" :key="u.id" class="row">
                  <RouterLink :to="`/users/${u.id}`" class="row-link">
                    <i class="pi pi-user row-icon" />
                    <span class="row-main">
                      <span class="row-name">{{ u.displayName ?? u.samAccountName }}</span>
                      <span class="row-sub">
                        {{ u.samAccountName }}
                        <span v-if="u.email"> · {{ u.email }}</span>
                      </span>
                    </span>
                    <span class="row-flags">
                      <span v-if="!u.enabled" class="flag flag-muted">disabled</span>
                      <span v-if="u.locked" class="flag flag-warn">locked</span>
                    </span>
                  </RouterLink>
                </li>
              </ul>
            </div>

            <!-- Groups -->
            <div v-else-if="activeTab === 'groups'" class="contents">
              <div v-if="contents.groups.length === 0" class="hint">
                No groups live directly in this OU.
              </div>
              <ul v-else class="row-list">
                <li v-for="g in contents.groups" :key="g.id" class="row">
                  <RouterLink :to="`/groups/${g.id}`" class="row-link">
                    <i class="pi pi-objects-column row-icon" />
                    <span class="row-main">
                      <span class="row-name">{{ g.name ?? g.samAccountName ?? '—' }}</span>
                      <span v-if="g.description" class="row-sub">{{ g.description }}</span>
                    </span>
                  </RouterLink>
                </li>
              </ul>
            </div>

            <!-- Computers -->
            <div v-else-if="activeTab === 'computers'" class="contents">
              <div v-if="contents.computers.length === 0" class="hint">
                No computers live directly in this OU.
              </div>
              <ul v-else class="row-list">
                <li v-for="c in contents.computers" :key="c.id" class="row">
                  <RouterLink :to="`/computers/${c.id}`" class="row-link">
                    <i class="pi pi-desktop row-icon" />
                    <span class="row-main">
                      <span class="row-name">{{ c.name ?? c.samAccountName ?? '—' }}</span>
                      <span class="row-sub">
                        <span v-if="c.dnsHostName">{{ c.dnsHostName }}</span>
                        <span v-if="c.operatingSystem"> · {{ c.operatingSystem }}</span>
                      </span>
                    </span>
                    <span class="row-flags">
                      <span v-if="!c.enabled" class="flag flag-muted">disabled</span>
                    </span>
                  </RouterLink>
                </li>
              </ul>
            </div>

            <!-- Group Policies. Linked-here and inherited are kept in
                 separate sections so the operator can tell at a glance
                 which links live on this OU vs. trickle down from
                 parents/domain root. Order within each matches AD
                 precedence (closest ancestor first, then link order). -->
            <div v-else-if="activeTab === 'policies'" class="contents">
              <div v-if="totalGpoCount === 0" class="hint">
                No GPOs are linked to or inherited by this OU.
              </div>
              <section v-if="contents.linkedGroupPolicies.length > 0" class="contents-section">
                <h2 class="section-h">Linked here</h2>
                <ul class="row-list">
                  <li
                    v-for="(p, idx) in contents.linkedGroupPolicies"
                    :key="`l-${p.id}-${idx}`"
                    class="row"
                  >
                    <RouterLink :to="`/policies/groups/${p.id}`" class="row-link">
                      <i class="pi pi-shield row-icon" />
                      <span class="row-main">
                        <span class="row-name">{{ p.displayName ?? p.gpoGuid }}</span>
                        <span class="row-sub mono">{{ p.gpoGuid }}</span>
                      </span>
                      <span class="row-flags">
                        <span v-if="!p.enabled" class="flag flag-muted">link disabled</span>
                        <span v-if="p.enforced" class="flag flag-warn">enforced</span>
                      </span>
                    </RouterLink>
                  </li>
                </ul>
              </section>
              <section v-if="contents.inheritedGroupPolicies.length > 0" class="contents-section">
                <h2 class="section-h">Inherited from ancestors</h2>
                <ul class="row-list">
                  <li
                    v-for="(p, idx) in contents.inheritedGroupPolicies"
                    :key="`i-${p.id}-${idx}`"
                    class="row"
                  >
                    <RouterLink :to="`/policies/groups/${p.id}`" class="row-link">
                      <i class="pi pi-shield row-icon" />
                      <span class="row-main">
                        <span class="row-name">{{ p.displayName ?? p.gpoGuid }}</span>
                        <span class="row-sub">
                          from <strong>{{ p.scopeName ?? p.scopeDn }}</strong>
                        </span>
                      </span>
                      <span class="row-flags">
                        <span v-if="!p.enabled" class="flag flag-muted">link disabled</span>
                        <span v-if="p.enforced" class="flag flag-warn">enforced</span>
                      </span>
                    </RouterLink>
                  </li>
                </ul>
              </section>
            </div>
          </div>
        </div>
      </Card>
    </div>

    <!-- Context menu — shown by onTreeNodeContext on right-click of a tree
         label. Items are computed reactively from capability flags + the
         freshly-fetched child counts. -->
    <ContextMenu ref="ctxMenu" :model="ctxItems">
      <template #item="{ item, props }">
        <!-- Informational row (e.g. the OU's description). Non-clickable,
             multi-line, deliberately distinct from the action items above.
             MenuItem.label is typed as string | function | undefined; we
             coerce to string for the title attribute. -->
        <div
          v-if="item.kind === 'info'"
          class="ctx-info"
          :title="typeof item.label === 'string' ? item.label : ''"
        >
          <i v-if="item.icon" :class="['ctx-info-icon', item.icon]" />
          <span class="ctx-info-text">{{ item.label }}</span>
        </div>
        <span v-else v-bind="props.action" :title="item.tooltip">
          <i v-if="item.icon" :class="item.icon" />
          <span>{{ item.label }}</span>
        </span>
      </template>
    </ContextMenu>

    <!-- Add child OU dialog -->
    <Dialog
      :visible="createDialogOpen"
      modal
      header="Add child OU"
      :style="{ width: '32rem' }"
      :closable="!createSubmitting"
      @update:visible="(v) => !v && (createDialogOpen = false)"
    >
      <p class="dialog-prose primary">
        Create a new organizational unit under
        <strong>{{ createParent?.name }}</strong
        >.
      </p>
      <p class="dialog-prose secondary">
        Reserved characters (<code>, = + &lt; &gt; # ; \ "</code>) are not allowed in the name.
      </p>
      <div class="create-form">
        <div class="form-row">
          <label class="fld-label">Name</label>
          <InputText
            v-model="createDraft.name"
            placeholder="e.g. Engineering"
            autofocus
            fluid
            :disabled="createSubmitting"
            @keyup.enter="onCreateSubmit"
          />
        </div>
        <div class="form-row">
          <label class="fld-label">Description (optional)</label>
          <Textarea
            v-model="createDraft.description"
            rows="2"
            auto-resize
            class="w-full"
            :disabled="createSubmitting"
          />
        </div>
        <div v-if="createPreviewDn" class="preview-row">
          <span class="muted">DN:</span>
          <code class="dn-line">{{ createPreviewDn }}</code>
        </div>
        <Message v-if="createError" severity="error" :closable="false">{{ createError }}</Message>
      </div>
      <template #footer>
        <Button
          label="Cancel"
          text
          severity="secondary"
          :disabled="createSubmitting"
          @click="createDialogOpen = false"
        />
        <Button
          label="Create OU"
          icon="pi pi-folder-plus"
          :loading="createSubmitting"
          :disabled="!createDraft.name.trim()"
          @click="onCreateSubmit"
        />
      </template>
    </Dialog>

    <!-- Edit OU dialog. The name is shown read-only — renaming an OU
         cascades the new path into every descendant's DN, which would
         leave our cache and audit history in a messy half-rewritten
         state until the next full sync. Description is the only mutable
         field today. -->
    <Dialog
      :visible="editDialogOpen"
      modal
      header="Edit OU"
      :style="{ width: '32rem' }"
      :closable="!editSubmitting"
      @update:visible="(v) => !v && (editDialogOpen = false)"
    >
      <p class="dialog-prose primary">
        Update the description for <strong>{{ editTarget?.name }}</strong
        >.
      </p>
      <p class="dialog-prose secondary">
        Renaming an OU isn’t supported here — it would rewrite the DN of every nested user, group,
        and sub-OU.
      </p>
      <div class="create-form">
        <div class="form-row">
          <label class="fld-label">Name</label>
          <InputText :value="editTarget?.name ?? ''" disabled fluid />
        </div>
        <div class="form-row">
          <label class="fld-label">Description</label>
          <Textarea
            v-model="editDraft.description"
            rows="3"
            auto-resize
            class="w-full"
            :disabled="editSubmitting"
          />
        </div>
        <Message v-if="editError" severity="error" :closable="false">{{ editError }}</Message>
      </div>
      <template #footer>
        <Button
          label="Cancel"
          text
          severity="secondary"
          :disabled="editSubmitting"
          @click="editDialogOpen = false"
        />
        <Button
          label="Save"
          icon="pi pi-check"
          :loading="editSubmitting"
          :disabled="!editIsDirty"
          @click="onEditSubmit"
        />
      </template>
    </Dialog>

    <!-- Delete OU confirm. The context-menu item is already gated on the
         OU being empty; this dialog still confirms the action because OU
         deletion is irreversible from the operator's perspective. -->
    <Dialog
      :visible="deleteDialogOpen"
      modal
      header="Delete OU"
      :style="{ width: '30rem' }"
      :closable="!deleteSubmitting"
      @update:visible="(v) => !v && (deleteDialogOpen = false)"
    >
      <p class="dialog-prose primary">
        Permanently delete <strong>{{ deleteTarget?.name }}</strong
        >?
      </p>
      <p class="dialog-prose secondary">
        This removes the OU from Active Directory. The action is recorded in the audit log.
      </p>
      <code v-if="deleteTarget" class="dn-line">{{ deleteTarget.distinguishedName }}</code>
      <Message v-if="deleteError" severity="error" :closable="false" class="mt-3">{{
        deleteError
      }}</Message>
      <template #footer>
        <Button
          label="Cancel"
          text
          severity="secondary"
          :disabled="deleteSubmitting"
          @click="deleteDialogOpen = false"
        />
        <Button
          label="Delete"
          icon="pi pi-trash"
          severity="danger"
          :loading="deleteSubmitting"
          @click="onDeleteSubmit"
        />
      </template>
    </Dialog>

    <Toast position="top-right" />
  </div>
</template>

<style scoped>
.ou-browser {
  gap: 12px;
}

.ou-grid {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  flex: 1 1 0;
  min-height: 0;
}

.ou-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* Make the Card primitive a flex column so its head stays put and the body
   grows to fill the pane and scrolls when its contents overflow. The Card
   primitive itself doesn't ship with these layout rules — they'd be wrong
   for shorter cards elsewhere — so we apply them only inside .ou-pane. */
.ou-pane :deep(.dc-card) {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
}

.ou-pane :deep(.dc-card-head) {
  flex: 0 0 auto;
}

.ou-pane :deep(.dc-card-body) {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
}

.pane-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.pane-h {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
  letter-spacing: -0.005em;
}

.pane-title-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pane-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
}

.pane-body {
  min-height: 0;
}

.hint {
  font-size: 12px;
  color: var(--text-3);
  padding: 12px 4px;
}

.hint.error {
  color: var(--danger, #d97070);
}

.dn-line {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
  display: inline-block;
}

.ou-tree {
  border: none;
  background: transparent;
  padding: 0;
}

.tree-label {
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tree-icon {
  font-size: 13px;
  color: var(--text);
  /* Tree-icons are rendered slightly larger than text so the folder shape
     reads at a glance. The default 13px-rem icon weight makes the glyph
     feel "solid" against the page background. */
}

/* "Solid" feel for parents — full-strength color. */
.tree-label.has-children .tree-icon {
  color: var(--text);
  opacity: 1;
}

/* "Outlined" feel for leaves — muted color + lower opacity, so the
   PrimeIcons folder-open glyph still reads as "this is where you are" but
   visually distinct from a parent that still has unexpanded children. */
.tree-label.leaf .tree-icon {
  color: var(--text-3);
  opacity: 0.7;
}

.tree-label.stale {
  color: var(--text-3);
  font-style: italic;
}

.tree-label.stale .tree-icon {
  color: var(--text-3);
  opacity: 0.5;
}

.stale-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 4px;
  color: var(--text-3);
}

.contents-tabs {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

/* Tab bar matches the user/group detail pages so the visual language is
   consistent — same accent underline, same count chip. */
.ou-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}

.ds-tab {
  background: transparent;
  border: 0;
  padding: 9px 12px;
  color: var(--text-3);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  position: relative;
  border-radius: 6px 6px 0 0;
  font-family: var(--font-sans);
}

.ds-tab:hover {
  color: var(--text);
}

.ds-tab.active {
  color: var(--text);
}

.ds-tab.active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
}

.ds-tab-count {
  font-size: 11px;
  margin-left: 6px;
  color: var(--text-3);
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: 3px;
}

.ds-tab.active .ds-tab-count {
  color: var(--text-2);
}

.mono {
  font-family: var(--font-mono);
}

.contents {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.contents-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-h {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-3);
  margin: 0 0 4px;
}

.row-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row {
  margin: 0;
}

.row-link {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 6px;
  text-decoration: none;
  color: var(--text);
  border: 1px solid transparent;
}

.row-link:hover {
  background: var(--hover);
  border-color: var(--border);
}

.row-icon {
  color: var(--text-3);
  font-size: 13px;
}

.row-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.row-name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-flags {
  display: flex;
  gap: 4px;
}

.flag {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
}

.flag-muted {
  color: var(--text-3);
  background: var(--surface-2);
}

.flag-warn {
  color: #b8860b;
  border-color: #b8860b;
  background: color-mix(in oklab, #b8860b 10%, transparent);
}

/* Dialog typography. The other dialogs in the app use `dialog-prose` from
   their own scoped styles; reproduced here so this view doesn't depend on
   another component's leak. */
.dialog-prose {
  font-size: 13px;
  margin: 0 0 8px;
}
.dialog-prose.primary {
  color: var(--text);
}
.dialog-prose.secondary {
  color: var(--text-3);
  font-size: 12px;
  margin-bottom: 14px;
}
.dialog-prose code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 1px 4px;
  background: var(--surface-2);
  border-radius: 3px;
}

.create-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.preview-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.muted {
  color: var(--text-3);
}
.mt-3 {
  margin-top: 12px;
}

/* Description row in the context menu — informational, not clickable. */
.ctx-info {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  max-width: 320px;
  cursor: default;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.4;
}

.ctx-info-icon {
  flex: 0 0 14px;
  margin-top: 2px;
  color: var(--text-3);
  font-size: 12px;
}

.ctx-info-text {
  flex: 1;
  min-width: 0;
  /* Description can be a paragraph — wrap rather than truncate so the
     operator can read it. Cap at a few lines to keep menus reasonable. */
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
