<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import Message from 'primevue/message';
import { fmtAbsolute, fmtRelative } from '../lib/format.js';

defineProps<{ name: string; lastSyncAt: string | null }>();
</script>

<template>
  <Message severity="info" :closable="false">
    {{ name }} isn’t in Microsoft Entra yet, so has no licenses there. It appears when Connect Sync
    next runs, which can’t be started from here.
    <template v-if="lastSyncAt">
      The tenant last synced {{ fmtRelative(lastSyncAt) }} ({{ fmtAbsolute(lastSyncAt) }}).
    </template>
  </Message>
</template>
