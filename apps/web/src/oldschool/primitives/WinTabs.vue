<!-- SPDX-License-Identifier: BUSL-1.1
     Classic Win32 tabbed dialog header. The active tab body is
     rendered by the parent via a slot that switches on the selected
     tab id — this component only handles tab rendering + state. -->
<script setup lang="ts">
defineProps<{
  tabs: { id: string; label: string }[];
  modelValue: string;
}>();
defineEmits<{
  (e: 'update:modelValue', v: string): void;
}>();
</script>

<template>
  <div class="os-tabs" role="tablist">
    <div
      v-for="t in tabs"
      :key="t.id"
      role="tab"
      class="os-tab"
      :class="{ active: modelValue === t.id }"
      :aria-selected="modelValue === t.id"
      @click="$emit('update:modelValue', t.id)"
    >
      {{ t.label }}
    </div>
  </div>
</template>
