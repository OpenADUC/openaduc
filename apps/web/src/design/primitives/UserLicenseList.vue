<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
// A user's Microsoft licenses, read live from Entra: each product by name,
// whether it comes from a group (linked to the AD group it's synced from)
// or is assigned directly, and why Entra couldn't assign it. Read-only:
// licenses are assigned in Entra, usually by adding the user to a group.
import { watch } from 'vue';
import { RouterLink } from 'vue-router';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { LICENSE_ERROR_TEXT, type LicenseAssignment } from '@openaduc/shared';
import { useUserLicenses } from '../composables/useLicenses.js';
import { fmtAbsolute, fmtRelative } from '../lib/format.js';
import EmptyState from './EmptyState.vue';

const props = defineProps<{ userId: string; name: string }>();

const { licenses, loading, error, load } = useUserLicenses();
watch(
  () => props.userId,
  (id) => void load(id),
  { immediate: true },
);

const problem = (a: LicenseAssignment) =>
  a.error || a.state === 'error' ? LICENSE_ERROR_TEXT[a.error ?? 'Other'] : null;
const plans = (n: number) => `${n} service plan${n === 1 ? '' : 's'} turned off`;
</script>

<template>
  <div class="lic">
    <p v-if="loading" class="hint">Reading {{ name }}’s licenses from Microsoft Entra…</p>

    <Message v-else-if="error" severity="error" :closable="false">
      Couldn’t read {{ name }}’s licenses: {{ error }}
      <Button label="Try again" size="small" text @click="load(userId)" />
    </Message>

    <Message v-else-if="licenses?.status === 'unsynced'" severity="info" :closable="false">
      {{ name }} isn’t in Microsoft Entra yet, so has no licenses. They appear when Connect Sync
      next runs, which can’t be started from here.
      <template v-if="licenses.lastSyncAt">
        The tenant last synced {{ fmtRelative(licenses.lastSyncAt) }} ({{
          fmtAbsolute(licenses.lastSyncAt)
        }}).
      </template>
    </Message>

    <EmptyState
      v-else-if="licenses?.status === 'synced' && licenses.licenses.length === 0"
      icon="pi pi-id-card"
      :title="`${name} has no licenses`"
      message="Adding them to a licensed group gives them its licenses."
    />

    <ul v-else-if="licenses?.status === 'synced'" class="lic-list">
      <li v-for="l in licenses.licenses" :key="l.skuId" class="lic-item">
        <div class="lic-head">
          <span class="lic-name">{{ l.name }}</span>
          <span v-if="l.skuPartNumber && l.skuPartNumber !== l.name" class="lic-part mono">{{
            l.skuPartNumber
          }}</span>
        </div>
        <ul class="lic-sources">
          <li
            v-for="(a, i) in l.assignments"
            :key="a.group?.entraGroupId ?? `direct-${i}`"
            class="lic-source"
          >
            <span v-if="!a.group">Assigned directly</span>
            <span v-else>
              From
              <RouterLink
                v-if="a.group.groupId"
                :to="{ name: 'group-detail', params: { id: a.group.groupId } }"
                >{{ a.group.name ?? 'a group' }}</RouterLink
              >
              <span
                v-else
                :title="`Entra group ${a.group.entraGroupId}, not synced from a group OpenADUC has`"
                >{{ a.group.name ?? 'a group Microsoft Entra didn’t name' }} (Entra)</span
              >
            </span>
            <span v-if="a.state === 'disabled'" class="badge badge-muted">disabled</span>
            <span v-if="a.disabledPlans > 0" class="hint">· {{ plans(a.disabledPlans) }}</span>
            <p
              v-if="problem(a)"
              class="lic-error"
              :class="{ 'lic-error-partial': a.state === 'activeWithError' }"
            >
              <i class="pi pi-exclamation-triangle" aria-hidden="true" />
              {{ problem(a) }}
            </p>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.lic-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.lic-item {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.lic-item:last-child {
  border-bottom: none;
}

.lic-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.lic-name {
  font-weight: 600;
  color: var(--text);
}

.lic-part {
  font-size: 11px;
  color: var(--text-3);
}

.lic-sources {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--text-2);
}

.lic-source {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.lic-error {
  flex-basis: 100%;
  margin: 2px 0 0;
  color: var(--red);
}

.lic-error-partial {
  color: var(--amber);
}
</style>
