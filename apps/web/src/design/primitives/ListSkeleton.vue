<!-- SPDX-License-Identifier: BUSL-1.1
     Rows shaped like a directory list's, shown in its table (the DataTable's
     empty slot) while the list first loads. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Skeleton from 'primevue/skeleton';
import { useThemeStore } from '../stores/useTheme.js';

export type ListSkeletonColumn = 'check' | 'avatar' | 'avatar-rounded' | 'badge' | 'text';

const props = defineProps<{
  /** What each column of the table shows, in order. Once the table is
   *  measured its header cells decide how many columns there are; a column
   *  this doesn't name shows text. */
  columns: readonly ListSkeletonColumn[];
}>();

const theme = useThemeStore();

const root = ref<HTMLElement | null>(null);
// Measured from the table: each header cell's box, and the room under the
// header. Until then (or where there's no layout), twelve rows in columns
// sized by what they show.
const cells = ref<{ width: number; padLeft: number; padRight: number }[] | null>(null);
const room = ref<number | null>(null);

const rowCount = computed(() =>
  room.value === null ? 12 : Math.max(1, Math.ceil(room.value / theme.listRowHeight)),
);

const kinds = computed<readonly ListSkeletonColumn[]>(() =>
  cells.value ? cells.value.map((_, i) => props.columns[i] ?? 'text') : props.columns,
);

const gridColumns = computed(() =>
  cells.value
    ? cells.value.map((c) => `${c.width}px`).join(' ')
    : kinds.value.map((c) => (c === 'avatar' || c === 'avatar-rounded' ? '2fr' : '1fr')).join(' '),
);

function cellPadding(i: number): Record<string, string> {
  const c = cells.value?.[i];
  return c ? { paddingLeft: `${c.padLeft}px`, paddingRight: `${c.padRight}px` } : {};
}

function measure(): void {
  const el = root.value;
  const table = el?.closest('.p-datatable');
  const scroller = el?.closest('.p-virtualscroller, .p-datatable-table-container');
  if (!el || !table || !scroller) return;
  const headers = [...table.querySelectorAll('thead > tr:first-child > th')];
  const widths = headers.map((th) => {
    const style = getComputedStyle(th);
    return {
      width: th.getBoundingClientRect().width,
      padLeft: parseFloat(style.paddingLeft) || 0,
      padRight: parseFloat(style.paddingRight) || 0,
    };
  });
  // No layout (a test DOM, a hidden tab): keep the defaults.
  if (widths.length === 0 || widths.some((w) => w.width === 0)) return;
  cells.value = widths;
  const head = table.querySelector('thead')?.getBoundingClientRect().height ?? 0;
  room.value = Math.max(0, scroller.clientHeight - head);
}

let observer: ResizeObserver | null = null;
onMounted(() => {
  measure();
  const scroller = root.value?.closest('.p-virtualscroller, .p-datatable-table-container');
  if (scroller && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure);
    observer.observe(scroller);
  }
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div
    ref="root"
    class="list-skeleton skeleton-delayed"
    aria-hidden="true"
    :style="room === null ? undefined : { height: `${room}px` }"
  >
    <div
      v-for="n in rowCount"
      :key="n"
      class="list-skeleton-row"
      :style="{ height: `${theme.listRowHeight}px`, gridTemplateColumns: gridColumns }"
    >
      <div v-for="(kind, i) in kinds" :key="i" class="list-skeleton-cell" :style="cellPadding(i)">
        <Skeleton v-if="kind === 'check'" width="14px" height="14px" border-radius="3px" />
        <template v-else-if="kind === 'avatar' || kind === 'avatar-rounded'">
          <Skeleton
            size="28px"
            :shape="kind === 'avatar' ? 'circle' : undefined"
            :border-radius="kind === 'avatar' ? undefined : '5px'"
          />
          <div class="list-skeleton-stack">
            <Skeleton :width="`${55 + ((n * 7) % 30)}%`" height="10px" />
            <Skeleton :width="`${35 + ((n * 11) % 25)}%`" height="8px" />
          </div>
        </template>
        <Skeleton v-else-if="kind === 'badge'" width="72px" height="20px" border-radius="4px" />
        <Skeleton v-else :width="`${45 + ((n * 13 + i * 7) % 40)}%`" height="10px" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.list-skeleton {
  overflow: hidden;
}

.list-skeleton-row {
  display: grid;
  align-items: center;
  box-sizing: border-box;
  border-bottom: 1px solid var(--border);
}

.list-skeleton-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 0 14px;
}

.list-skeleton-stack {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
