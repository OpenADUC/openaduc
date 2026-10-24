<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  An import's results: its progress while it runs, then each row's
  result with a link to the account, the retry of what failed, and the
  results CSV. The workflow lives in useImportJob; this renders it.
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Button from 'primevue/button';
import Message from 'primevue/message';
import type { ImportJobRow, ImportResultsDownload } from '@openaduc/shared';
import BulkJobPanel from '../design/feedback/BulkJobPanel.vue';
import PageHeader from '../design/primitives/PageHeader.vue';
import { useImportJob } from '../design/composables/useImportJob.js';
import { bulkJobTitle } from '../design/lib/bulkJob.js';
import { fmtAbsolute } from '../design/lib/format.js';

const props = defineProps<{ id: string }>();

function save({ fileName, csv }: ImportResultsDownload): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

const imp = useImportJob({ save });
const { job, rows, results, loading, loadError, failure, busy, resultsNote } = imp;

watch(
  () => props.id,
  (id) => void imp.open(id),
  { immediate: true },
);

const title = computed(() =>
  job.value
    ? bulkJobTitle(job.value, job.value.counts.total, job.value.actorDisplayName)
    : 'Import',
);

const STATUS: Record<ImportJobRow['status'], { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'muted' },
  running: { label: 'Creating', tone: 'blue' },
  succeeded: { label: 'Created', tone: 'green' },
  partial: { label: 'Created, partly set up', tone: 'amber' },
  failed: { label: 'Not created', tone: 'red' },
  skipped: { label: 'Skipped', tone: 'muted' },
};

/** What went wrong for a row: each failed step, or why it wasn't created. */
const problemsOf = (row: ImportJobRow): string[] =>
  row.failed.length > 0
    ? row.failed.map((f) => f.message)
    : row.errorMessage && row.status !== 'succeeded'
      ? [row.errorMessage]
      : [];

const downloadLabel = computed(() =>
  results.value?.passwords === 'held' ? 'Download results with passwords' : 'Download results',
);
</script>

<template>
  <div class="page-inner ij-page">
    <PageHeader :title="title" :sub="job ? `Started ${fmtAbsolute(job.createdAt)}` : ''">
      <template #actions>
        <RouterLink :to="{ name: 'user-import' }" class="ij-new">Import more users</RouterLink>
      </template>
    </PageHeader>

    <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>
    <p v-else-if="loading && !job" class="hint">Loading…</p>

    <template v-if="job">
      <BulkJobPanel
        :job="job"
        :failure="failure"
        :busy="busy"
        @stop="imp.stop"
        @continue="imp.continueJob"
        @retry="imp.retry"
      />

      <section v-if="results" class="ij-section" aria-labelledby="ij-results">
        <h2 id="ij-results" class="ij-title">Results CSV</h2>
        <p class="ij-note">{{ resultsNote }}</p>
        <div class="ij-download">
          <Button
            :label="downloadLabel"
            icon="pi pi-download"
            :loading="imp.downloading.value"
            :disabled="!imp.canDownload.value"
            @click="imp.download"
          />
          <span v-if="!imp.stopped.value" class="hint">Once the import has stopped.</span>
        </div>
        <Message v-if="imp.downloadError.value" severity="error" :closable="false" class="ij-msg">
          {{ imp.downloadError.value }}
        </Message>
      </section>

      <section class="ij-section" aria-labelledby="ij-rows">
        <h2 id="ij-rows" class="ij-title">People</h2>
        <div class="ij-table-wrap">
          <table class="ij-table">
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Name</th>
                <th scope="col">Username</th>
                <th scope="col">UPN</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.line">
                <td class="mono">{{ row.line }}</td>
                <td>
                  <RouterLink v-if="row.id" :to="{ name: 'user-detail', params: { id: row.id } }">
                    {{ row.displayName }}
                  </RouterLink>
                  <span v-else>{{ row.displayName }}</span>
                </td>
                <td class="mono">{{ row.samAccountName }}</td>
                <td class="mono">{{ row.userPrincipalName }}</td>
                <td>
                  <span class="badge" :class="`badge-${STATUS[row.status].tone}`">
                    <span class="badge-dot" />{{ STATUS[row.status].label }}
                  </span>
                  <ul v-if="problemsOf(row).length" class="ij-problems">
                    <li v-for="(p, i) in problemsOf(row)" :key="i">{{ p }}</li>
                  </ul>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ij-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 72rem;
}

.ij-new {
  font-size: 13px;
}

.ij-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ij-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.ij-note {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
}

.ij-download {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ij-msg {
  margin: 0;
}

.ij-table-wrap {
  overflow-x: auto;
}

.ij-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.ij-table th {
  text-align: left;
  font-weight: 600;
  color: var(--text-3);
  font-size: 12px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.ij-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.ij-table .mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.ij-problems {
  margin: 6px 0 0;
  padding-left: 16px;
  font-size: 12px;
  color: var(--text-2);
}
</style>
