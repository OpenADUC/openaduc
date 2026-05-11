<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Move…" dialog: pick a destination OU from the tree and
     OK. Only users have a backend mutation in our API today; for groups
     and computers we show the picker but disable OK with a tooltip
     explaining why. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';
import type { DirectoryOu } from '@openaduc/shared';

const props = defineProps<{
  objectKind: 'user' | 'group' | 'computer';
  id: string;
  label: string;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const auth = useAuthStore();
const store = useOldSchool();
const toast = useToast();
const visible = ref(true);

const ous = ref<DirectoryOu[]>([]);
const expanded = ref<Set<string>>(new Set());
const selected = ref<string | null>(null);
const err = ref<string | null>(null);

onMounted(async () => {
  try {
    const resp = await api.ous.list();
    ous.value = resp.ous;
    // Expand root level on open.
    expanded.value = new Set(resp.ous.filter((o) => !o.parentDn).map((o) => o.distinguishedName));
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : (e as Error).message;
  }
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

const canOk = computed(() => props.objectKind === 'user' && !!selected.value);

async function ok(): Promise<void> {
  if (props.objectKind !== 'user') return;
  if (!selected.value) return;
  err.value = null;
  auth.requireEdit(async () => {
    try {
      await api.users.move(props.id, { targetOuDn: selected.value! });
      toast.add({ severity: 'success', summary: `${props.label} moved.`, life: 3000 });
      store.bumpData();
      visible.value = false;
      emit('close');
    } catch (e) {
      err.value = e instanceof ApiError ? e.message : (e as Error).message;
    }
  }, 'Moving an object requires step-up authentication.');
}
</script>

<template>
  <WinDialog
    :visible="visible"
    title="Move"
    icon="ou"
    :width="440"
    hide-apply
    ok-label="OK"
    :can-ok="canOk"
    @ok="ok"
    @cancel="$emit('close')"
    @update:visible="(v) => !v && $emit('close')"
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
          :class="{ selected: selected === r.dn }"
          :style="{ paddingLeft: `${r.depth * 16 + 6}px` }"
          @click="selected = r.dn"
          @dblclick="toggle(r)"
        >
          <span @click.stop="toggle(r)" style="width: 14px; text-align: center; cursor: pointer">
            {{ r.hasChildren ? (r.expanded ? '▾' : '▸') : '' }}
          </span>
          <WinIcon name="ou" :size="14" />
          <span>{{ r.label }}</span>
        </div>
        <div v-if="rows.length === 0" class="os-listbox-empty">No organizational units.</div>
      </div>
      <div v-if="objectKind !== 'user'" class="os-info" style="margin-top: 10px">
        Moving {{ objectKind }} objects is not yet supported by the backend.
      </div>
      <div v-if="err" class="os-error" style="margin-top: 10px">{{ err }}</div>
    </div>
  </WinDialog>
</template>
