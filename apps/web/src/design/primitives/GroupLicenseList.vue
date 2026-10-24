<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
// The Microsoft licenses a group grants its members through group-based
// licensing, read live from Entra. Group pickers' badges follow it.
import { watch } from 'vue';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { useGroupLicenses } from '../composables/useLicenses.js';
import { fmtAbsolute, fmtRelative } from '../lib/format.js';

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
const plans = (n: number) => `${n} service plan${n === 1 ? '' : 's'} turned off`;
</script>

<template>
  <div class="glic">
    <p v-if="loading" class="hint">Reading the licenses {{ name }} grants…</p>

    <Message v-else-if="error" severity="error" :closable="false">
      Couldn’t read the licenses {{ name }} grants: {{ error }}
      <Button label="Try again" size="small" text @click="load(groupId)" />
    </Message>

    <p v-else-if="licenses?.status === 'unsynced'" class="hint">
      {{ name }} isn’t in Microsoft Entra yet, so grants no licenses. It appears when Connect Sync
      next runs<template v-if="licenses.lastSyncAt"
        >; the tenant last synced {{ fmtRelative(licenses.lastSyncAt) }} ({{
          fmtAbsolute(licenses.lastSyncAt)
        }})</template
      >.
    </p>

    <template v-else-if="licenses?.status === 'synced'">
      <p v-if="licenses.licenses.length === 0" class="hint">
        {{ name }} grants no licenses. They’re assigned to groups in Microsoft Entra.
      </p>
      <template v-else>
        <p class="glic-intro">Members get these through the group:</p>
        <ul class="glic-list">
          <li v-for="l in licenses.licenses" :key="l.skuId" class="glic-item">
            <span class="glic-name">{{ l.name }}</span>
            <span v-if="l.skuPartNumber && l.skuPartNumber !== l.name" class="glic-part mono">{{
              l.skuPartNumber
            }}</span>
            <span v-if="l.disabledPlans > 0" class="hint">· {{ plans(l.disabledPlans) }}</span>
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

.glic-name {
  font-weight: 600;
  color: var(--text);
}

.glic-part {
  font-size: 11px;
  color: var(--text-3);
}
</style>
