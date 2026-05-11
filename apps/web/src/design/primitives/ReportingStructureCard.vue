<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import Avatar from './Avatar.vue';
import EmptyState from './EmptyState.vue';
import SectionCard from './SectionCard.vue';

interface ReportRef {
  id: string | null;
  distinguishedName: string;
  displayName: string | null;
}

const props = defineProps<{
  manager: ReportRef | null;
  directReports: ReportRef[];
  /** Display name of the focal user (rendered in the middle of the chain). */
  selfName: string | null;
}>();

// Cap visible reports so the tree fits on one screen even for VPs with
// dozens of reports. Anything past the cap surfaces as a "+N more" tile.
const REPORTS_VISIBLE = 12;

const reports = computed(() => props.directReports.slice(0, REPORTS_VISIBLE));
const overflow = computed(() => Math.max(0, props.directReports.length - reports.value.length));
const hasMultipleReports = computed(() => reports.value.length + (overflow.value > 0 ? 1 : 0) > 1);

const isEmpty = computed(() => !props.manager && props.directReports.length === 0);

function nameOf(ref: ReportRef): string {
  return ref.displayName ?? ref.distinguishedName.split(',')[0]?.replace(/^CN=/i, '') ?? 'Unknown';
}
</script>

<template>
  <SectionCard title="Reporting structure" icon="pi pi-sitemap" :cols="1">
    <div v-if="isEmpty" class="rs-empty">
      <EmptyState
        icon="pi pi-sitemap"
        title="No reporting data"
        description="This account has no manager set and no direct reports."
      />
    </div>

    <div v-else class="rs-tree">
      <!-- Manager (above the focal user) -->
      <template v-if="manager">
        <div class="rs-row">
          <RouterLink
            v-if="manager.id"
            :to="`/users/${manager.id}`"
            class="rs-node rs-node-link rs-node-manager"
          >
            <Avatar :name="nameOf(manager)" :seed="manager.distinguishedName" :size="36" />
            <div class="rs-node-meta">
              <div class="rs-node-name">{{ nameOf(manager) }}</div>
              <div class="rs-node-role">Manager</div>
            </div>
            <i class="pi pi-arrow-up-right rs-node-go" />
          </RouterLink>
          <div v-else class="rs-node rs-node-manager">
            <Avatar :name="nameOf(manager)" :seed="manager.distinguishedName" :size="36" />
            <div class="rs-node-meta">
              <div class="rs-node-name">{{ nameOf(manager) }}</div>
              <div class="rs-node-role" :title="manager.distinguishedName">
                Manager · not in cache
              </div>
            </div>
          </div>
        </div>
        <div class="rs-trunk" aria-hidden="true" />
      </template>

      <!-- Self (focal point) -->
      <div class="rs-row">
        <div class="rs-node rs-node-self">
          <Avatar :name="selfName ?? '?'" :seed="selfName ?? '?'" :size="40" />
          <div class="rs-node-meta">
            <div class="rs-node-name">{{ selfName ?? '—' }}</div>
            <div class="rs-node-role">This account</div>
          </div>
        </div>
      </div>

      <!-- Direct reports — branches fan out below the self node -->
      <template v-if="reports.length > 0">
        <div class="rs-trunk" aria-hidden="true" />
        <!-- Horizontal rail (only meaningful when 2+ reports) -->
        <div v-if="hasMultipleReports" class="rs-rail" aria-hidden="true" />
        <div class="rs-row rs-row-reports" :class="{ 'has-rail': hasMultipleReports }">
          <RouterLink
            v-for="r in reports"
            :key="r.distinguishedName"
            :to="r.id ? `/users/${r.id}` : ''"
            class="rs-node rs-node-report"
            :class="{ 'rs-node-link': !!r.id, 'rs-node-disabled': !r.id }"
            :title="r.distinguishedName"
          >
            <Avatar :name="nameOf(r)" :seed="r.distinguishedName" :size="32" />
            <div class="rs-node-meta">
              <div class="rs-node-name">{{ nameOf(r) }}</div>
              <div v-if="!r.id" class="rs-node-role">not in cache</div>
            </div>
          </RouterLink>
          <div v-if="overflow > 0" class="rs-node rs-node-overflow">+{{ overflow }} more</div>
        </div>
        <div class="rs-reports-count">Direct reports · {{ directReports.length }}</div>
      </template>
    </div>
  </SectionCard>
</template>

<style scoped>
.rs-tree {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 4px 4px;
  width: 100%;
}

/* A row holds one or more nodes at a single level of the tree. */
.rs-row {
  display: flex;
  align-items: stretch;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  width: 100%;
}

.rs-node {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  text-decoration: none;
  color: var(--text);
  min-width: 200px;
  max-width: 260px;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    transform 120ms ease;
  position: relative;
}

.rs-node-link:hover {
  background: var(--hover);
  border-color: var(--border-strong);
  transform: translateY(-1px);
}

.rs-node-disabled {
  opacity: 0.7;
  cursor: default;
  pointer-events: none;
}

.rs-node-meta {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.rs-node-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rs-node-role {
  font-size: 10.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
  margin-top: 2px;
}

.rs-node-go {
  margin-left: auto;
  color: var(--text-3);
  font-size: 11px;
}

/* Self is the focal point — accent ring + bolder background. */
.rs-node-self {
  background: var(--accent-soft);
  border-color: color-mix(in oklab, var(--accent) 45%, transparent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 12%, transparent);
}

.rs-node-self .rs-node-role {
  color: var(--accent-text);
  font-weight: 600;
  text-transform: uppercase;
}

.rs-node-report {
  min-width: 160px;
  max-width: 220px;
}

.rs-node-overflow {
  background: transparent;
  border-style: dashed;
  color: var(--text-3);
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 12px;
  min-width: 80px;
}

/* ---------- Connectors ----------
 * The tree uses three primitives:
 *   .rs-trunk — a short vertical line between two stacked rows
 *   .rs-rail  — the horizontal bar above the reports row
 *   ::before  — a per-report stub that drops from the rail to the card top
 */
.rs-trunk {
  width: 1px;
  height: 18px;
  background: var(--border-strong);
}

.rs-rail {
  height: 1px;
  /* Centered, spans roughly the inner width of the reports row so it
     sits over the bulk of the cards without overshooting on the edges. */
  width: min(100%, 70%);
  background: var(--border-strong);
  /* No margin-bottom — the report cards' ::before stems sit immediately
     under the rail. */
}

/* When the reports row sits under a rail, each card grows a little stub
   above its top edge so it visually "hangs" from the rail. */
.rs-row-reports.has-rail .rs-node::before {
  content: '';
  position: absolute;
  bottom: 100%;
  left: 50%;
  width: 1px;
  height: 12px;
  background: var(--border-strong);
}

.rs-reports-count {
  margin-top: 12px;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.rs-empty {
  padding: 8px 0;
}

/* On narrow screens the report cards wrap, which makes the straight rail
   misalign with their tops. Drop the rail and stems and let the trunk
   alone hint at "below the self." */
@media (max-width: 639.98px) {
  .rs-rail {
    display: none;
  }
  .rs-row-reports.has-rail .rs-node::before {
    display: none;
  }
  .rs-node {
    min-width: 0;
    width: 100%;
    max-width: 100%;
  }
}
</style>
