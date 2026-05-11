<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { initialsFor, avatarGradientFor } from '../lib/format.js';

const props = withDefaults(
  defineProps<{
    name: string | null | undefined;
    seed?: string | null;
    size?: number;
    /**
     * Optional photo URL (e.g. /api/directories/:id/users/:id/photo). When
     * the image loads successfully it covers the initials background; on a
     * 404 / network failure we fall back to the initials silently — no
     * console noise, no broken-image icon.
     */
    photoUrl?: string | null;
    /**
     * 'circle' for users (matches the photo affordance), 'rounded' for
     * non-person directory objects (groups, computers, GPOs) so they read
     * as a different class of thing at a glance.
     */
    shape?: 'circle' | 'rounded';
    /**
     * Optional PrimeIcons class name (e.g. `pi-desktop`). When set, the
     * avatar renders the icon instead of initials — used by Computer and
     * GPO heros where there's no useful name to derive letters from.
     */
    icon?: string | null;
  }>(),
  { size: 26, shape: 'circle' },
);

const initials = computed(() => initialsFor(props.name));
const background = computed(() => avatarGradientFor(props.seed ?? props.name ?? '?'));
const fontSize = computed(() => Math.round(props.size * 0.4));
const iconSize = computed(() => Math.round(props.size * 0.46));

// Tracks whether the current photoUrl loaded OK. Reset whenever the URL
// changes so swapping users doesn't briefly show the previous person's
// photo over the new initials.
const photoFailed = ref(false);
watch(
  () => props.photoUrl,
  () => {
    photoFailed.value = false;
  },
);
</script>

<template>
  <span
    class="ds-avatar"
    :class="{ 'ds-avatar-rounded': shape === 'rounded' }"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${fontSize}px`, background }"
  >
    <img
      v-if="photoUrl && !photoFailed"
      class="ds-avatar-img"
      :src="photoUrl"
      :alt="name ?? ''"
      @error="photoFailed = true"
    />
    <i v-else-if="icon" :class="['pi', icon]" :style="{ fontSize: `${iconSize}px` }" />
    <template v-else>{{ initials }}</template>
  </span>
</template>

<style scoped>
.ds-avatar {
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  font-weight: 600;
  letter-spacing: -0.02em;
  flex-shrink: 0;
  user-select: none;
  overflow: hidden;
  position: relative;
  /* Force aspect ratio so the avatar can't get squashed by a flex parent
     that gives the text column ellipsis treatment — older usages saw
     vertical stretching when the parent flex-shrunk on narrow widths. */
  aspect-ratio: 1 / 1;
  box-sizing: border-box;
  transition:
    width 200ms ease,
    height 200ms ease,
    font-size 200ms ease,
    border-radius 200ms ease;
}

.ds-avatar-rounded {
  border-radius: 18%;
}

.ds-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
