<!-- SPDX-License-Identifier: BUSL-1.1
     Small SVG icon set that evokes the classic ADUC iconography
     (user heads, group silhouettes, monitors, folders). Not pixel
     traces of the originals — just close enough to read as ADUC
     at 16×16. Disabled/locked variants overlay a red marker. -->
<script setup lang="ts">
import { computed } from 'vue';

type IconKind =
  | 'aduc'
  | 'domain'
  | 'ou'
  | 'container'
  | 'user'
  | 'user-disabled'
  | 'user-locked'
  | 'group'
  | 'group-distribution'
  | 'computer'
  | 'computer-disabled'
  | 'builtin'
  | 'savedQueries'
  | 'gpo'
  | 'refresh'
  | 'find'
  | 'help'
  | 'properties'
  | 'menu-check'
  | 'newuser'
  | 'newgroup'
  | 'newcomputer'
  | 'newou'
  | 'expand-all'
  | 'collapse-all';

const props = withDefaults(
  defineProps<{
    name: IconKind;
    size?: number;
  }>(),
  { size: 16 },
);

const sz = computed(() => `${props.size}px`);
</script>

<template>
  <span class="winicon" :style="{ width: sz, height: sz }">
    <!-- user / disabled / locked -->
    <svg
      v-if="name === 'user' || name === 'user-disabled' || name === 'user-locked'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <rect x="0.5" y="0.5" width="15" height="15" fill="#dfe6f0" stroke="#7d8aa0" />
      <circle cx="8" cy="6" r="2.6" fill="#fce4b6" stroke="#7a5b1f" stroke-width="0.6" />
      <path
        d="M3.5 14 C3.5 11 5.5 9.6 8 9.6 C10.5 9.6 12.5 11 12.5 14 Z"
        fill="#fce4b6"
        stroke="#7a5b1f"
        stroke-width="0.6"
      />
      <path
        v-if="name === 'user-disabled'"
        d="M2 14 L14 2 M2 2 L14 14"
        stroke="#c00"
        stroke-width="1.4"
        stroke-linecap="round"
      />
      <g v-if="name === 'user-locked'">
        <rect
          x="9"
          y="9.5"
          width="6"
          height="5"
          rx="0.4"
          fill="#f1c232"
          stroke="#7a5b1f"
          stroke-width="0.5"
        />
        <path
          d="M10.3 9.5 V8.2 C10.3 7 11 6.5 12 6.5 C13 6.5 13.7 7 13.7 8.2 V9.5"
          fill="none"
          stroke="#7a5b1f"
          stroke-width="0.8"
        />
      </g>
    </svg>

    <!-- group / distribution -->
    <svg
      v-else-if="name === 'group' || name === 'group-distribution'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <rect x="0.5" y="0.5" width="15" height="15" fill="#dfe6f0" stroke="#7d8aa0" />
      <circle cx="5" cy="6" r="1.8" fill="#fce4b6" stroke="#7a5b1f" stroke-width="0.5" />
      <circle cx="11" cy="6" r="1.8" fill="#fce4b6" stroke="#7a5b1f" stroke-width="0.5" />
      <circle cx="8" cy="5" r="2.1" fill="#fce4b6" stroke="#7a5b1f" stroke-width="0.5" />
      <path
        d="M2 14 C2 11.7 3.4 10.7 5 10.7 C6.6 10.7 8 11.7 8 14 Z"
        fill="#fce4b6"
        stroke="#7a5b1f"
        stroke-width="0.5"
      />
      <path
        d="M8 14 C8 11.7 9.4 10.7 11 10.7 C12.6 10.7 14 11.7 14 14 Z"
        fill="#fce4b6"
        stroke="#7a5b1f"
        stroke-width="0.5"
      />
      <path
        d="M4 14 C4 11 6 9.6 8 9.6 C10 9.6 12 11 12 14 Z"
        fill="#fce4b6"
        stroke="#7a5b1f"
        stroke-width="0.5"
      />
      <circle
        v-if="name === 'group-distribution'"
        cx="13"
        cy="3"
        r="2.4"
        fill="#ffffff"
        stroke="#5a5a5a"
        stroke-width="0.6"
      />
      <path
        v-if="name === 'group-distribution'"
        d="M11 2 L13 4 L15 2"
        fill="none"
        stroke="#5a5a5a"
        stroke-width="0.8"
      />
    </svg>

    <!-- computer -->
    <svg
      v-else-if="name === 'computer' || name === 'computer-disabled'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <rect x="1" y="2.5" width="14" height="9.5" rx="0.4" fill="#e9eef3" stroke="#56627a" />
      <rect
        x="2.2"
        y="3.6"
        width="11.6"
        height="7"
        fill="#1d4f8c"
        stroke="#0b2c54"
        stroke-width="0.4"
      />
      <path d="M2.5 13 L13.5 13 L14.5 14.5 L1.5 14.5 Z" fill="#bcc6d3" stroke="#56627a" />
      <path
        v-if="name === 'computer-disabled'"
        d="M2 14 L14 2 M2 2 L14 14"
        stroke="#c00"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>

    <!-- OU folder (book/page overlay) -->
    <svg
      v-else-if="name === 'ou'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <path
        d="M1 4 L6 4 L7.4 5.4 L15 5.4 L15 13.5 L1 13.5 Z"
        fill="#f4d271"
        stroke="#876d24"
        stroke-width="0.7"
        stroke-linejoin="round"
      />
      <rect
        x="5.5"
        y="2.5"
        width="6"
        height="6"
        fill="#ffffff"
        stroke="#876d24"
        stroke-width="0.6"
      />
      <line x1="6.5" y1="4" x2="10.5" y2="4" stroke="#5b80b8" stroke-width="0.7" />
      <line x1="6.5" y1="5.3" x2="10.5" y2="5.3" stroke="#5b80b8" stroke-width="0.7" />
      <line x1="6.5" y1="6.6" x2="9.5" y2="6.6" stroke="#5b80b8" stroke-width="0.7" />
    </svg>

    <!-- Generic container (plain folder) -->
    <svg
      v-else-if="name === 'container'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <path
        d="M1 4 L6 4 L7.4 5.4 L15 5.4 L15 13.5 L1 13.5 Z"
        fill="#f4d271"
        stroke="#876d24"
        stroke-width="0.7"
        stroke-linejoin="round"
      />
    </svg>

    <!-- Domain (globe-like) -->
    <svg
      v-else-if="name === 'domain'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <circle cx="8" cy="8" r="6.4" fill="#3a78c2" stroke="#1d4f8c" />
      <ellipse cx="8" cy="8" rx="6.4" ry="2.6" fill="none" stroke="#ffffff" stroke-width="0.7" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6.4" fill="none" stroke="#ffffff" stroke-width="0.7" />
      <line x1="1.6" y1="8" x2="14.4" y2="8" stroke="#ffffff" stroke-width="0.7" />
    </svg>

    <!-- Saved Queries -->
    <svg
      v-else-if="name === 'savedQueries'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <path
        d="M1 4 L6 4 L7.4 5.4 L15 5.4 L15 13.5 L1 13.5 Z"
        fill="#f4d271"
        stroke="#876d24"
        stroke-width="0.7"
        stroke-linejoin="round"
      />
      <circle cx="10.5" cy="9" r="3" fill="none" stroke="#1a3a6a" stroke-width="1.1" />
      <line
        x1="12.6"
        y1="11.2"
        x2="14.5"
        y2="13.5"
        stroke="#1a3a6a"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>

    <!-- ADUC app icon (folder + people) -->
    <svg
      v-else-if="name === 'aduc'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <path
        d="M1 3.6 L6 3.6 L7.4 5 L15 5 L15 13 L1 13 Z"
        fill="#f4d271"
        stroke="#5b3f0e"
        stroke-width="0.7"
        stroke-linejoin="round"
      />
      <circle cx="6" cy="9" r="1.4" fill="#ffffff" stroke="#5b3f0e" stroke-width="0.5" />
      <circle cx="10" cy="9" r="1.4" fill="#ffffff" stroke="#5b3f0e" stroke-width="0.5" />
      <path
        d="M3.6 12.7 C3.6 10.9 4.7 10.2 6 10.2 C7.3 10.2 8.4 10.9 8.4 12.7 Z"
        fill="#ffffff"
        stroke="#5b3f0e"
        stroke-width="0.5"
      />
      <path
        d="M7.6 12.7 C7.6 10.9 8.7 10.2 10 10.2 C11.3 10.2 12.4 10.9 12.4 12.7 Z"
        fill="#ffffff"
        stroke="#5b3f0e"
        stroke-width="0.5"
      />
    </svg>

    <!-- Builtin (folder + gear/wrench feel) -->
    <svg
      v-else-if="name === 'builtin'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <path
        d="M1 4 L6 4 L7.4 5.4 L15 5.4 L15 13.5 L1 13.5 Z"
        fill="#f4d271"
        stroke="#876d24"
        stroke-width="0.7"
        stroke-linejoin="round"
      />
      <circle cx="10" cy="9.5" r="2.2" fill="#ffffff" stroke="#5a5a5a" stroke-width="0.6" />
      <circle cx="10" cy="9.5" r="0.7" fill="#5a5a5a" />
    </svg>

    <!-- GPO -->
    <svg
      v-else-if="name === 'gpo'"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      :style="{ width: sz, height: sz }"
    >
      <rect x="2" y="2" width="12" height="13" fill="#ffffff" stroke="#5a5a5a" stroke-width="0.7" />
      <line x1="3.5" y1="4.5" x2="12.5" y2="4.5" stroke="#3a78c2" stroke-width="0.9" />
      <line x1="3.5" y1="6.5" x2="12.5" y2="6.5" stroke="#5a5a5a" stroke-width="0.7" />
      <line x1="3.5" y1="8.5" x2="12.5" y2="8.5" stroke="#5a5a5a" stroke-width="0.7" />
      <line x1="3.5" y1="10.5" x2="10" y2="10.5" stroke="#5a5a5a" stroke-width="0.7" />
    </svg>

    <!-- Toolbar icons (simpler glyphs) -->
    <svg v-else-if="name === 'refresh'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <path d="M3 8 A5 5 0 0 1 12.5 6" fill="none" stroke="#1d4f8c" stroke-width="1.4" />
      <polygon points="12.5,3.6 13.2,7 9.8,6.2" fill="#1d4f8c" />
      <path d="M13 8 A5 5 0 0 1 3.5 10" fill="none" stroke="#1d4f8c" stroke-width="1.4" />
      <polygon points="3.5,12.4 2.8,9 6.2,9.8" fill="#1d4f8c" />
    </svg>
    <svg v-else-if="name === 'find'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <circle cx="7" cy="7" r="4" fill="none" stroke="#1d4f8c" stroke-width="1.4" />
      <line
        x1="10"
        y1="10"
        x2="14"
        y2="14"
        stroke="#1d4f8c"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
    <svg v-else-if="name === 'help'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <circle cx="8" cy="8" r="6.4" fill="#fff" stroke="#1d4f8c" stroke-width="1" />
      <text
        x="8"
        y="12"
        text-anchor="middle"
        font-family="Segoe UI"
        font-size="11"
        font-weight="700"
        fill="#1d4f8c"
      >
        ?
      </text>
    </svg>
    <svg v-else-if="name === 'properties'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <rect x="2" y="3" width="12" height="11" fill="#fff" stroke="#5a5a5a" />
      <line x1="4" y1="6" x2="12" y2="6" stroke="#3a78c2" stroke-width="1.2" />
      <line x1="4" y1="8.5" x2="12" y2="8.5" stroke="#5a5a5a" />
      <line x1="4" y1="10.5" x2="12" y2="10.5" stroke="#5a5a5a" />
      <line x1="4" y1="12.5" x2="9" y2="12.5" stroke="#5a5a5a" />
    </svg>
    <svg v-else-if="name === 'newuser'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <circle cx="6" cy="6" r="2.4" fill="#fce4b6" stroke="#7a5b1f" stroke-width="0.6" />
      <path
        d="M2 14 C2 11 4 9.6 6 9.6 C8 9.6 10 11 10 14 Z"
        fill="#fce4b6"
        stroke="#7a5b1f"
        stroke-width="0.6"
      />
      <circle cx="12" cy="11.5" r="3.2" fill="#fff" stroke="#1a7a3a" stroke-width="0.6" />
      <line x1="12" y1="9.7" x2="12" y2="13.3" stroke="#1a7a3a" stroke-width="1.4" />
      <line x1="10.2" y1="11.5" x2="13.8" y2="11.5" stroke="#1a7a3a" stroke-width="1.4" />
    </svg>
    <svg v-else-if="name === 'newgroup'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <circle cx="5" cy="6" r="2" fill="#fce4b6" stroke="#7a5b1f" stroke-width="0.5" />
      <circle cx="9" cy="6" r="2" fill="#fce4b6" stroke="#7a5b1f" stroke-width="0.5" />
      <path
        d="M2 13 C2 10.5 3.5 9.5 5 9.5 C6.5 9.5 8 10.5 8 13 Z"
        fill="#fce4b6"
        stroke="#7a5b1f"
        stroke-width="0.5"
      />
      <path
        d="M6 13 C6 10.5 7.5 9.5 9 9.5 C10.5 9.5 12 10.5 12 13 Z"
        fill="#fce4b6"
        stroke="#7a5b1f"
        stroke-width="0.5"
      />
      <circle cx="13" cy="12" r="3" fill="#fff" stroke="#1a7a3a" stroke-width="0.6" />
      <line x1="13" y1="10.2" x2="13" y2="13.8" stroke="#1a7a3a" stroke-width="1.3" />
      <line x1="11.2" y1="12" x2="14.8" y2="12" stroke="#1a7a3a" stroke-width="1.3" />
    </svg>
    <svg v-else-if="name === 'newcomputer'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <rect x="1" y="2.5" width="11" height="7.5" rx="0.4" fill="#e9eef3" stroke="#56627a" />
      <rect
        x="2"
        y="3.5"
        width="9"
        height="5.5"
        fill="#1d4f8c"
        stroke="#0b2c54"
        stroke-width="0.4"
      />
      <circle cx="12" cy="12" r="3" fill="#fff" stroke="#1a7a3a" stroke-width="0.6" />
      <line x1="12" y1="10.2" x2="12" y2="13.8" stroke="#1a7a3a" stroke-width="1.3" />
      <line x1="10.2" y1="12" x2="13.8" y2="12" stroke="#1a7a3a" stroke-width="1.3" />
    </svg>
    <svg v-else-if="name === 'newou'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <path
        d="M1 4 L6 4 L7.4 5.4 L13 5.4 L13 12 L1 12 Z"
        fill="#f4d271"
        stroke="#876d24"
        stroke-width="0.7"
      />
      <circle cx="12.5" cy="12.5" r="3" fill="#fff" stroke="#1a7a3a" stroke-width="0.6" />
      <line x1="12.5" y1="10.7" x2="12.5" y2="14.3" stroke="#1a7a3a" stroke-width="1.3" />
      <line x1="10.7" y1="12.5" x2="14.3" y2="12.5" stroke="#1a7a3a" stroke-width="1.3" />
    </svg>

    <!-- Tree expand/collapse all -->
    <svg v-else-if="name === 'expand-all'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="#1d4f8c" />
      <line x1="4" y1="8" x2="12" y2="8" stroke="#1d4f8c" stroke-width="1.4" />
      <line x1="8" y1="4" x2="8" y2="12" stroke="#1d4f8c" stroke-width="1.4" />
    </svg>
    <svg v-else-if="name === 'collapse-all'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="#1d4f8c" />
      <line x1="4" y1="8" x2="12" y2="8" stroke="#1d4f8c" stroke-width="1.4" />
    </svg>
    <svg v-else-if="name === 'menu-check'" viewBox="0 0 16 16" :style="{ width: sz, height: sz }">
      <polyline
        points="3,8 7,12 13,4"
        fill="none"
        stroke="#1d4f8c"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>
</template>

<style scoped>
.winicon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  flex-shrink: 0;
}
</style>
