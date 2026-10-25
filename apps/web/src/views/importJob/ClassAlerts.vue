<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  What holds an import's class passes back, as both the import's page and
  its class roster say it: the feature turned off, an authoriser who can
  no longer issue passes (with Take over where the reader may), people
  still not in Entra close to class, and passes held up for other reasons.
-->
<script setup lang="ts">
import Button from 'primevue/button';
import Message from 'primevue/message';
import type { ClassAlerts } from '@openaduc/shared';
import { fmtAbsolute } from '../../design/lib/format.js';

defineProps<{
  alerts: ClassAlerts;
  /** Offer Take over, rather than only saying someone can. */
  canTakeOver?: boolean;
  takingOver?: boolean;
}>();
defineEmits<{ takeOver: [] }>();

const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);
</script>

<template>
  <Message v-if="alerts.off" severity="warn" :closable="false" class="ca-msg">
    {{ alerts.off }}
  </Message>
  <Message v-if="alerts.authority" severity="warn" :closable="false" class="ca-msg">
    {{ alerts.authority.message }}
    <Button
      v-if="canTakeOver"
      label="Take over"
      size="small"
      class="ca-action"
      :loading="takingOver"
      @click="$emit('takeOver')"
    />
  </Message>
  <Message v-if="alerts.unsynced" severity="warn" :closable="false" class="ca-msg">
    {{ people(alerts.unsynced.count) }}
    {{ alerts.unsynced.count === 1 ? 'isn’t' : 'aren’t' }} in Microsoft Entra yet, and class starts
    {{ fmtAbsolute(alerts.unsynced.startsAt) }}. Their passes are made as soon as Connect Sync
    brings them; check that it’s running.
  </Message>
  <Message
    v-for="s in alerts.stuck"
    :key="s.message"
    severity="info"
    :closable="false"
    class="ca-msg"
  >
    {{ people(s.count) }}: their passes can’t be made yet. {{ s.message }} OpenADUC keeps trying.
  </Message>
</template>

<style scoped>
.ca-msg {
  margin: 0;
}

.ca-action {
  margin-left: 8px;
}
</style>
