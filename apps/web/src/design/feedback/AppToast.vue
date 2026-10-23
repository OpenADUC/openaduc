<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import Toast from 'primevue/toast';
import ToastBody from './ToastBody.vue';

// PrimeVue's Toast, plus an Undo button on messages built with `undoable`.
// Attributes such as `position` pass through to the Toast.
</script>

<template>
  <Toast>
    <template #message="{ message }">
      <ToastBody :message="message" />
    </template>
  </Toast>
</template>
