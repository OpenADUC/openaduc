<!-- SPDX-License-Identifier: BUSL-1.1
     Group Properties — classic 4-tab layout (General, Members, Member Of,
     Managed By). Read-only: there is no group write endpoint in the API
     today, so editable fields are disabled. Selection and view actions
     still feel right. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import WinDialog from './WinDialog.vue';
import WinTabs from '../primitives/WinTabs.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useOldSchool } from '../stores/useOldSchool.js';
import type { GroupDetail } from '@openaduc/shared';

const props = defineProps<{ windowId: number; id: string }>();
defineEmits<{ (e: 'close'): void }>();
const store = useOldSchool();

const group = ref<GroupDetail | null>(null);
const loading = ref(true);
const err = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  err.value = null;
  try {
    const resp = await api.groups.get(props.id);
    group.value = resp.group;
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => store.dataVersion, load);

type TabId = 'general' | 'members' | 'memberOf' | 'managedBy';
const tabs: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Members' },
  { id: 'memberOf', label: 'Member Of' },
  { id: 'managedBy', label: 'Managed By' },
];
const tab = ref<TabId>('general');

const title = computed(
  () => `${group.value?.name ?? group.value?.samAccountName ?? 'Group'} Properties`,
);

const isSecurity = computed(() =>
  (group.value?.groupType ?? '').toLowerCase().includes('security'),
);
const scope = computed(() => (group.value?.groupScope ?? '').toLowerCase());
</script>

<template>
  <WinDialog
    :window-id="windowId"
    :title="title"
    icon="group"
    hide-apply
    @ok="$emit('close')"
    @cancel="$emit('close')"
    @close="$emit('close')"
  >
    <div v-if="loading" style="padding: 24px; text-align: center">Loading…</div>
    <div v-else-if="!group" class="os-error" style="padding: 16px">
      {{ err ?? 'Unable to load group.' }}
    </div>
    <template v-else>
      <WinTabs :tabs="tabs" v-model="tab" />
      <div class="os-tab-body">
        <template v-if="tab === 'general'">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px">
            <WinIcon name="group" :size="36" />
            <strong>{{ group.name ?? group.samAccountName }}</strong>
          </div>
          <hr
            style="border: 0; border-top: 1px solid var(--os-window-border-soft); margin: 0 0 14px"
          />
          <div class="os-form">
            <label class="label">Group name (pre-Windows 2000):</label>
            <input class="os-input" :value="group.samAccountName ?? ''" disabled />
            <label class="label">Description:</label>
            <input class="os-input" :value="group.description ?? ''" disabled />
            <label class="label">E-mail:</label>
            <input class="os-input" :value="group.email ?? ''" disabled />
          </div>
          <fieldset class="os-groupbox">
            <legend>Group scope</legend>
            <label class="os-check disabled"
              ><input type="radio" :checked="scope === 'domain-local'" disabled /> Domain
              local</label
            >
            <label class="os-check disabled" style="margin-left: 16px"
              ><input type="radio" :checked="scope === 'global'" disabled /> Global</label
            >
            <label class="os-check disabled" style="margin-left: 16px"
              ><input type="radio" :checked="scope === 'universal'" disabled /> Universal</label
            >
          </fieldset>
          <fieldset class="os-groupbox">
            <legend>Group type</legend>
            <label class="os-check disabled"
              ><input type="radio" :checked="isSecurity" disabled /> Security</label
            >
            <label class="os-check disabled" style="margin-left: 16px"
              ><input type="radio" :checked="!isSecurity" disabled /> Distribution</label
            >
          </fieldset>
          <div class="os-form">
            <label class="label">Notes:</label>
            <textarea class="os-textarea" rows="3" disabled />
          </div>
        </template>

        <template v-else-if="tab === 'members'">
          <div style="margin-bottom: 6px">Members:</div>
          <div class="os-listbox" style="min-height: 220px; max-height: 320px">
            <div v-if="group.members.length === 0" class="os-listbox-empty">
              This group has no members.
            </div>
            <div v-for="m in group.members" :key="m.id" class="os-listbox-row">
              <WinIcon :name="m.enabled ? 'user' : 'user-disabled'" :size="14" />
              <span style="flex: 1">{{ m.displayName ?? m.samAccountName }}</span>
              <span style="color: var(--os-window-text-muted)">{{
                m.userPrincipalName ?? m.email ?? ''
              }}</span>
            </div>
          </div>
          <div style="display: flex; gap: 6px; margin-top: 8px">
            <button class="os-btn" disabled>Add…</button>
            <button class="os-btn" disabled>Remove</button>
          </div>
        </template>

        <template v-else-if="tab === 'memberOf'">
          <div class="os-info">
            Nested-of relationships are not surfaced by the directory cache.
          </div>
          <div class="os-listbox" style="min-height: 220px; max-height: 320px">
            <div class="os-listbox-empty">(no data)</div>
          </div>
        </template>

        <template v-else-if="tab === 'managedBy'">
          <div class="os-form" style="grid-template-columns: 80px 1fr">
            <label class="label">Name:</label>
            <div style="display: flex; gap: 6px">
              <input class="os-input" disabled />
              <button class="os-btn" disabled>Change…</button>
              <button class="os-btn" disabled>Properties</button>
              <button class="os-btn" disabled>Clear</button>
            </div>
            <label class="label">Office:</label>
            <input class="os-input" disabled />
            <label class="label">Street:</label>
            <textarea class="os-textarea" disabled />
            <label class="label">City:</label>
            <input class="os-input" disabled />
            <label class="label">State/province:</label>
            <input class="os-input" disabled />
            <label class="label">Country/region:</label>
            <input class="os-input" disabled />
            <label class="label">Telephone:</label>
            <input class="os-input" disabled />
            <label class="label">Fax:</label>
            <input class="os-input" disabled />
          </div>
          <label class="os-check disabled" style="margin-top: 12px">
            <input type="checkbox" disabled />
            Manager can update membership list
          </label>
        </template>
      </div>
    </template>
  </WinDialog>
</template>
