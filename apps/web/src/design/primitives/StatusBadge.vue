<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import {
  userStatus,
  userStatusLabel,
  type UserStatusKind,
  type UserStatusInput,
} from '../lib/format.js';

const props = withDefaults(
  defineProps<{
    /** Pass either a user-shaped object … */
    user?: UserStatusInput | null;
    /** … or an explicit kind. */
    kind?: UserStatusKind;
    /** Custom label; defaults to the kind label. */
    label?: string;
    dot?: boolean;
    /** Visual size. `lg` is used in hero contexts so the status reads
     *  at a glance — particularly important for "Disabled". */
    size?: 'sm' | 'md' | 'lg';
  }>(),
  { dot: true, size: 'md' },
);

const resolvedKind = computed<UserStatusKind>(() => {
  if (props.kind) return props.kind;
  if (props.user) return userStatus(props.user);
  return 'active';
});

const tone = computed(() => {
  switch (resolvedKind.value) {
    case 'locked':
    case 'expired':
    case 'pwd-expired':
      return 'red';
    case 'pwd-expiring':
      return 'amber';
    case 'disabled':
      return 'muted';
    case 'active':
      return 'green';
    default:
      return 'muted';
  }
});

const text = computed(() => props.label ?? userStatusLabel(resolvedKind.value));
</script>

<template>
  <!-- The size suffix targets the global .badge.badge-lg modifier in
       theme.css so the styling is shared with inline `<span class="badge
       badge-amber badge-lg">…</span>` chips used in the user-detail hero. -->
  <span class="badge" :class="[`badge-${tone}`, `badge-${size}`]">
    <span v-if="dot" class="badge-dot" />
    {{ text }}
  </span>
</template>
