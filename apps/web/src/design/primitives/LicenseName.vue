<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import type { LicenseSku } from '@openaduc/shared';

defineProps<{ license: LicenseSku }>();
</script>

<template>
  <span class="lic-name">{{ license.name }}</span>
  <span
    v-if="license.skuPartNumber && license.skuPartNumber !== license.name"
    class="lic-part mono"
    >{{ license.skuPartNumber }}</span
  >
</template>

<style scoped>
.lic-name {
  font-weight: 600;
  color: var(--text);
}

.lic-part {
  font-size: 11px;
  color: var(--text-3);
}
</style>
