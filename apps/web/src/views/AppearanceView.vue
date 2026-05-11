<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import PageHeader from '../design/primitives/PageHeader.vue';
import AppearanceTab from './settings/AppearanceTab.vue';
</script>

<template>
  <div class="page-inner appearance-page">
    <PageHeader title="Appearance" />
    <AppearanceTab />
  </div>
</template>

<style scoped>
.appearance-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
