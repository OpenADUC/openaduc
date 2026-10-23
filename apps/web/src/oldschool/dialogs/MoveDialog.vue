<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Move…" dialog for a user: pick a destination OU from the
     tree and OK. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';
import { useUserMove } from '../../design/composables/useUserMove.js';
import type { DirectoryOu } from '@openaduc/shared';

const props = defineProps<{ windowId: number; id: string; label: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();
const { ous, loading, destination, atCurrent, ready, error, load, submit } = useUserMove({
  onMoved: () => {
    toast.add({ severity: 'success', summary: `${props.label} moved.`, life: 3000 });
    store.bumpData();
    emit('close');
  },
});

onMounted(() => load(props.id));

const expanded = ref<Set<string>>(new Set());

// Open the root level and the path down to where the user is now.
watch(ous, (list) => {
  const byDn = new Map(list.map((o) => [o.distinguishedName.toLowerCase(), o]));
  const open = new Set(list.filter((o) => !o.parentDn).map((o) => o.distinguishedName));
  let parent = destination.value ? byDn.get(destination.value.toLowerCase())?.parentDn : null;
  while (parent) {
    const ou = byDn.get(parent.toLowerCase());
    if (!ou || open.has(ou.distinguishedName)) break;
    open.add(ou.distinguishedName);
    parent = ou.parentDn;
  }
  expanded.value = open;
});

interface OuRow {
  dn: string;
  label: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

const rows = computed<OuRow[]>(() => {
  const byParent = new Map<string | null, DirectoryOu[]>();
  for (const o of ous.value) {
    const k = o.parentDn ? o.parentDn.toLowerCase() : null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(o);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  const out: OuRow[] = [];
  const walk = (parent: string | null, depth: number): void => {
    const children = byParent.get(parent) ?? [];
    for (const o of children) {
      const has = (byParent.get(o.distinguishedName.toLowerCase()) ?? []).length > 0;
      const exp = expanded.value.has(o.distinguishedName);
      out.push({ dn: o.distinguishedName, label: o.name, depth, hasChildren: has, expanded: exp });
      if (exp) walk(o.distinguishedName.toLowerCase(), depth + 1);
    }
  };
  walk(null, 0);
  return out;
});

function toggle(r: OuRow): void {
  const s = new Set(expanded.value);
  if (s.has(r.dn)) s.delete(r.dn);
  else s.add(r.dn);
  expanded.value = s;
}
</script>

<template>
  <WinDialog
    :window-id="windowId"
    title="Move"
    icon="ou"
    hide-apply
    ok-label="OK"
    :can-ok="ready"
    @ok="submit"
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div style="padding: 14px 16px; font-size: 12px">
      <div style="margin-bottom: 10px">
        Move object <strong>{{ label }}</strong> into container:
      </div>
      <div class="os-listbox" style="min-height: 240px; max-height: 320px">
        <div
          v-for="r in rows"
          :key="r.dn"
          class="os-listbox-row"
          :class="{ selected: destination === r.dn }"
          :style="{ paddingLeft: `${r.depth * 16 + 6}px` }"
          @click="destination = r.dn"
          @dblclick="toggle(r)"
        >
          <span @click.stop="toggle(r)" style="width: 14px; text-align: center; cursor: pointer">
            {{ r.hasChildren ? (r.expanded ? '▾' : '▸') : '' }}
          </span>
          <WinIcon name="ou" :size="14" />
          <span>{{ r.label }}</span>
        </div>
        <div v-if="loading" class="os-listbox-empty">Loading…</div>
        <div v-else-if="rows.length === 0" class="os-listbox-empty">No organizational units.</div>
      </div>
      <div v-if="atCurrent" class="os-info" style="margin-top: 10px">
        {{ label }} is already in this container.
      </div>
      <div v-if="error" class="os-error" style="margin-top: 10px">{{ error }}</div>
    </div>
  </WinDialog>
</template>
