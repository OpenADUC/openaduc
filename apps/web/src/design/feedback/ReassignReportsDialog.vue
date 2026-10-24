<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Reassign a departing manager's direct reports: tick the reports that
  move, pick their new manager, see each one's manager change, then
  confirm. Renders a useReassignReports the page owns; confirming starts
  the bulk job.
-->
<script setup lang="ts">
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import StatusBadge from '../primitives/StatusBadge.vue';
import BulkEditPreview from './BulkEditPreview.vue';
import type { useReassignReports } from '../composables/useReassignReports.js';

const props = defineProps<{
  workflow: ReturnType<typeof useReassignReports>;
  /** Whose reports they are. */
  managerName: string;
}>();

const {
  visible,
  title,
  confirmLabel,
  reports,
  notListed,
  errors,
  selectedCount,
  allSelected,
  newManager,
  managerQuery,
  managerResults,
  managerSearching,
  managerSearchError,
  canPreview,
  preview,
  previewing,
  previewError,
  canConfirm,
  hasMore,
  loadingMore,
} = props.workflow;
const w = props.workflow;
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="title"
    :style="{ width: '36rem' }"
    @update:visible="(v) => !v && w.close()"
  >
    <template v-if="!preview">
      <section class="rr-section" aria-labelledby="rr-reports-label">
        <div class="rr-section-head">
          <h3 id="rr-reports-label" class="rr-section-title">{{ managerName }}’s direct reports</h3>
          <span v-if="reports.length > 0" class="rr-count"
            >{{ selectedCount }} of {{ reports.length }} selected</span
          >
          <Button
            v-if="reports.length > 0"
            :label="allSelected ? 'Select none' : 'Select all'"
            size="small"
            severity="secondary"
            text
            @click="allSelected ? w.selectNone() : w.selectAll()"
          />
        </div>
        <Message v-if="reports.length === 0" severity="warn" :closable="false">
          {{
            notListed === 1
              ? 'Their direct report isn’t in the cache, so it can’t be reassigned here.'
              : `None of their ${notListed} direct reports are in the cache, so they can’t be reassigned here.`
          }}
          Run a directory sync from Tasks, then try again.
        </Message>
        <ul v-else class="rr-reports">
          <li v-for="r in reports" :key="r.id" class="rr-report">
            <Checkbox
              :model-value="w.isSelected(r.id)"
              :input-id="`rr-${r.id}`"
              binary
              @update:model-value="w.toggle(r.id)"
            />
            <label :for="`rr-${r.id}`" class="rr-report-label">
              <span class="rr-report-name">{{ r.name }}</span>
              <StatusBadge v-if="r.disabled" kind="disabled" size="sm" />
              <span v-if="errors.get(r.id)" class="rr-problem">{{ errors.get(r.id) }}</span>
            </label>
          </li>
        </ul>
        <p v-if="notListed > 0 && reports.length > 0" class="rr-note">
          {{
            notListed === 1
              ? '1 report isn’t in the cache, so it isn’t listed.'
              : `${notListed} reports aren’t in the cache, so they aren’t listed.`
          }}
        </p>
      </section>

      <section class="rr-section">
        <h3 class="rr-section-title">New manager</h3>
        <p v-if="newManager" class="rr-chosen"><i class="pi pi-user" /> {{ newManager.name }}</p>
        <InputText
          v-model="managerQuery"
          placeholder="Search users…"
          aria-label="Search for the new manager"
          fluid
        />
        <p v-if="managerSearching" class="rr-note">Searching…</p>
        <p v-else-if="managerSearchError" class="rr-problem">
          Couldn’t search users: {{ managerSearchError }}
        </p>
        <ul v-else-if="managerResults.length > 0" class="rr-results">
          <li v-for="u in managerResults" :key="u.id">
            <button type="button" class="rr-result" @click="w.chooseManager(u)">
              <span>{{ u.displayName ?? u.samAccountName }}</span>
              <span class="rr-result-sam mono">{{ u.samAccountName }}</span>
            </button>
          </li>
        </ul>
      </section>

      <Message v-if="previewError" severity="error" :closable="false" class="rr-message">
        Couldn’t work out what it would change: {{ previewError }}
      </Message>
    </template>

    <BulkEditPreview
      v-else
      :preview="preview"
      :has-more="hasMore"
      :loading-more="loadingMore"
      @show-more="w.showMore"
    />

    <template #footer>
      <template v-if="preview">
        <Button label="Back" severity="secondary" text @click="w.back" />
        <Button
          :label="confirmLabel"
          icon="pi pi-sitemap"
          :disabled="!canConfirm"
          @click="w.confirm"
        />
      </template>
      <template v-else>
        <Button label="Cancel" severity="secondary" text @click="w.close" />
        <Button
          label="Preview"
          icon="pi pi-eye"
          :loading="previewing"
          :disabled="!canPreview"
          @click="w.review"
        />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.rr-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.rr-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rr-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.rr-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3);
}

.rr-reports {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 16rem;
  overflow-y: auto;
}

.rr-report {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}

.rr-report:last-child {
  border-bottom: 0;
}

.rr-report-label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 13px;
  cursor: pointer;
}

.rr-report-label .rr-problem {
  flex-basis: 100%;
  margin: 0;
}

.rr-chosen {
  margin: 0;
  font-size: 13px;
}

.rr-results {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 10rem;
  overflow-y: auto;
}

.rr-result {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.rr-result:hover {
  background: var(--surface-2);
}

.rr-result-sam {
  font-size: 11.5px;
  color: var(--text-3);
}

.rr-problem {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--red);
}

.rr-note {
  margin: 4px 0 8px;
  font-size: 12.5px;
  color: var(--text-2);
}

.rr-message {
  margin: 8px 0;
}
</style>
