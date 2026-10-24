<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { onMounted } from 'vue';
import { useLicensedGroupsStore } from '../../stores/licensedGroups.js';
import { LICENSE_ICON } from '../lib/licenses.js';

const licensed = useLicensedGroupsStore();
onMounted(() => void licensed.ensureLoaded());
</script>

<template>
  <p v-if="licensed.badgeNote" class="hint license-note">
    <i :class="['pi', LICENSE_ICON]" aria-hidden="true" />
    {{ licensed.badgeNote }}
  </p>
</template>

<style scoped>
.license-note {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 6px 0 0;
}
</style>
