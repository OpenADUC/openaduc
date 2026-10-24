<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
// Marks a group that grants a Microsoft license, wherever a group is
// picked, so an operator sees that adding someone to it licenses them.
// From the shared licensed-groups cache: nothing per group is fetched.
import { computed, onMounted } from 'vue';
import { useLicensedGroupsStore } from '../../stores/licensedGroups.js';

const props = defineProps<{ groupId: string }>();

const licensed = useLicensedGroupsStore();
onMounted(() => void licensed.ensureLoaded());

const licenses = computed(() => licensed.licensesOf(props.groupId));
const label = computed(() =>
  licenses.value.length === 1 ? licenses.value[0]!.name : `${licenses.value.length} licenses`,
);
const title = computed(
  () => `Members get ${licenses.value.map((l) => l.name).join(', ')} through this group`,
);
</script>

<template>
  <span v-if="licenses.length" class="badge badge-green license-badge" :title="title">
    <i class="pi pi-id-card" aria-hidden="true" />
    <span class="license-badge-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.license-badge {
  max-width: 16rem;
  flex-shrink: 0;
}

.license-badge-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
