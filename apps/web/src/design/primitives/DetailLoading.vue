<!-- SPDX-License-Identifier: BUSL-1.1
     Shown by a detail page while its record loads. -->
<template>
  <div class="detail-loading" role="status">
    <i class="pi pi-spin pi-spinner" aria-hidden="true" /> <slot>Loading…</slot>
  </div>
</template>

<style scoped>
.detail-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 48px 0;
  justify-content: center;
  color: var(--text-2);
}
</style>
