<!-- SPDX-License-Identifier: BUSL-1.1
     Computer Properties — classic 6-tab layout (General, Operating
     System, Member Of, Delegation, Location, Managed By). Read-only:
     no computer-object write endpoint in the API today. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import WinDialog from './WinDialog.vue';
import WinTabs from '../primitives/WinTabs.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useOldSchool } from '../stores/useOldSchool.js';
import type { ComputerDetail } from '@openaduc/shared';

const props = defineProps<{ windowId: number; id: string }>();
defineEmits<{ (e: 'close'): void }>();
const store = useOldSchool();

const computer = ref<ComputerDetail | null>(null);
const loading = ref(true);
const err = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  err.value = null;
  try {
    const resp = await api.computers.get(props.id);
    computer.value = resp.computer;
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => store.dataVersion, load);

type TabId = 'general' | 'os' | 'memberOf' | 'delegation' | 'location' | 'managedBy';
const tabs: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'os', label: 'Operating System' },
  { id: 'memberOf', label: 'Member Of' },
  { id: 'delegation', label: 'Delegation' },
  { id: 'location', label: 'Location' },
  { id: 'managedBy', label: 'Managed By' },
];
const tab = ref<TabId>('general');

const title = computed(() => `${computer.value?.name ?? 'Computer'} Properties`);
function rawAttr(c: ComputerDetail, k: string): string {
  const v = (c.rawAttributes as Record<string, unknown>)[k];
  return Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
}
</script>

<template>
  <WinDialog
    :window-id="windowId"
    :title="title"
    icon="computer"
    hide-apply
    @ok="$emit('close')"
    @cancel="$emit('close')"
    @close="$emit('close')"
  >
    <div v-if="loading" style="padding: 24px; text-align: center">Loading…</div>
    <div v-else-if="!computer" class="os-error" style="padding: 16px">
      {{ err ?? 'Unable to load computer.' }}
    </div>
    <template v-else>
      <WinTabs :tabs="tabs" v-model="tab" />
      <div class="os-tab-body">
        <template v-if="tab === 'general'">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px">
            <WinIcon name="computer" :size="36" />
            <strong>{{ computer.name }}</strong>
          </div>
          <hr
            style="border: 0; border-top: 1px solid var(--os-window-border-soft); margin: 0 0 14px"
          />
          <div class="os-form">
            <label class="label">Computer name (pre-Windows 2000):</label>
            <input class="os-input" :value="computer.samAccountName ?? ''" disabled />
            <label class="label">DNS name:</label>
            <input class="os-input" :value="computer.dnsHostName ?? ''" disabled />
            <label class="label">DC Type:</label>
            <input
              class="os-input"
              :value="rawAttr(computer, 'machineRole') || 'Workstation or server'"
              disabled
            />
            <label class="label">Site:</label>
            <input class="os-input" :value="rawAttr(computer, 'msDS-SiteName')" disabled />
            <label class="label">Description:</label>
            <input class="os-input" :value="computer.description ?? ''" disabled />
          </div>
          <label class="os-check disabled" style="margin-top: 10px">
            <input type="checkbox" :checked="computer.enabled" disabled />
            Computer account is {{ computer.enabled ? 'enabled' : 'disabled' }}
          </label>
        </template>

        <template v-else-if="tab === 'os'">
          <div class="os-form">
            <label class="label">Name:</label>
            <input class="os-input" :value="computer.operatingSystem ?? ''" disabled />
            <label class="label">Version:</label>
            <input class="os-input" :value="computer.operatingSystemVersion ?? ''" disabled />
            <label class="label">Service pack:</label>
            <input
              class="os-input"
              :value="rawAttr(computer, 'operatingSystemServicePack')"
              disabled
            />
          </div>
        </template>

        <template v-else-if="tab === 'memberOf'">
          <div style="margin-bottom: 6px">Member of:</div>
          <div class="os-listbox" style="min-height: 200px; max-height: 300px">
            <div v-if="computer.groupMemberships.length === 0" class="os-listbox-empty">
              (no group memberships)
            </div>
            <div
              v-for="g in computer.groupMemberships"
              :key="g.distinguishedName"
              class="os-listbox-row"
            >
              <WinIcon name="group" :size="14" />
              <span style="flex: 1">{{ g.name ?? g.distinguishedName }}</span>
            </div>
          </div>
          <div style="display: flex; gap: 6px; margin-top: 8px">
            <button class="os-btn" disabled>Add…</button>
            <button class="os-btn" disabled>Remove</button>
          </div>
          <fieldset class="os-groupbox" style="margin-top: 14px">
            <legend>Primary group:</legend>
            <input class="os-input" value="Domain Computers" disabled style="margin-bottom: 6px" />
            <button class="os-btn" disabled>Set Primary Group</button>
          </fieldset>
        </template>

        <template v-else-if="tab === 'delegation'">
          <p>
            Delegation is a security-sensitive operation, which allows services to act on behalf of
            another user.
          </p>
          <label class="os-check disabled"
            ><input type="radio" checked disabled /> Do not trust this computer for
            delegation</label
          ><br />
          <label class="os-check disabled"
            ><input type="radio" disabled /> Trust this computer for delegation to any service
            (Kerberos only)</label
          ><br />
          <label class="os-check disabled"
            ><input type="radio" disabled /> Trust this computer for delegation to specified
            services only</label
          >
          <fieldset class="os-groupbox">
            <legend>Services to which this account can present delegated credentials:</legend>
            <div class="os-listbox" style="min-height: 100px">
              <div class="os-listbox-empty">(none)</div>
            </div>
            <div style="display: flex; gap: 6px; margin-top: 6px">
              <button class="os-btn" disabled>Add…</button>
              <button class="os-btn" disabled>Remove</button>
            </div>
          </fieldset>
        </template>

        <template v-else-if="tab === 'location'">
          <div class="os-form" style="grid-template-columns: 80px 1fr">
            <label class="label">Location:</label>
            <div style="display: flex; gap: 6px">
              <input class="os-input" :value="rawAttr(computer, 'location')" disabled />
              <button class="os-btn" disabled>Browse…</button>
            </div>
          </div>
        </template>

        <template v-else-if="tab === 'managedBy'">
          <div class="os-form" style="grid-template-columns: 80px 1fr">
            <label class="label">Name:</label>
            <div style="display: flex; gap: 6px">
              <input
                class="os-input"
                :value="
                  computer.managedBy?.displayName ?? computer.managedBy?.distinguishedName ?? ''
                "
                disabled
              />
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
        </template>
      </div>
    </template>
  </WinDialog>
</template>
