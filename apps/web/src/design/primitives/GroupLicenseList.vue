<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { watch } from 'vue';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { useGroupLicenses } from '../composables/useLicenses.js';
import { plansOffText } from '../lib/licenses.js';
import LicenseName from './LicenseName.vue';
import LicenseUnsynced from './LicenseUnsynced.vue';

const props = defineProps<{ groupId: string; name: string }>();

const { licenses, loading, error, load } = useGroupLicenses();
watch(
  () => props.groupId,
  (id) => void load(id),
  { immediate: true },
);

// Graph's licenseProcessingState while members' licenses are being updated.
const PROCESSING: Record<string, string> = {
  QueuedForProcessing: 'Entra is about to update its members’ licenses.',
  ProcessingInProgress: 'Entra is updating its members’ licenses.',
};
</script>

<template>
  <div class="glic">
    <p v-if="loading" class="hint">Reading the licenses {{ name }} grants…</p>

    <Message v-else-if="error" severity="error" :closable="false">
      Couldn’t read the licenses {{ name }} grants: {{ error }}
      <Button label="Try again" size="small" text @click="load(groupId)" />
    </Message>

    <LicenseUnsynced
      v-else-if="licenses?.status === 'unsynced'"
      :name="name"
      :last-sync-at="licenses.lastSyncAt"
    />

    <template v-else-if="licenses?.status === 'synced'">
      <p v-if="licenses.licenses.length === 0" class="hint">
        {{ name }} grants no licenses. They’re assigned to groups in Microsoft Entra.
      </p>
      <template v-else>
        <p class="glic-intro">Members get these through the group:</p>
        <ul class="glic-list">
          <li v-for="l in licenses.licenses" :key="l.skuId" class="glic-item">
            <LicenseName :license="l" />
            <span v-if="l.disabledPlanCount > 0" class="hint"
              >· {{ plansOffText(l.disabledPlanCount) }}</span
            >
          </li>
        </ul>
      </template>
      <p v-if="licenses.processingState && PROCESSING[licenses.processingState]" class="hint">
        {{ PROCESSING[licenses.processingState] }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.glic-intro {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--text-2);
}

.glic-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.glic-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
