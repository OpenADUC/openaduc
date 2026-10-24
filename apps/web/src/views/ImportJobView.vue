<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  An import's results: its progress while it runs, then each row's
  result with a link to the account and how its licenses stand in
  Entra, the retry of what failed, the results CSV, and once its
  passwords are gone, a reset of them. An import that issues TAPs for
  class has its class roster as a second tab. The workflow lives in
  useImportJob; this renders it.
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Button from 'primevue/button';
import Message from 'primevue/message';
import {
  IMPORT_LICENSE_STATE_LABEL,
  IMPORT_ROW_STATUS_LABEL,
  licenseProblem,
  type BulkJobResultsDownload,
  type ImportJobRow,
  type ImportLicenseState,
} from '@openaduc/shared';
import LicenseName from '../design/primitives/LicenseName.vue';
import BulkJobPanel from '../design/feedback/BulkJobPanel.vue';
import ClassAlerts from './importJob/ClassAlerts.vue';
import ImportJobTabs from './importJob/ImportJobTabs.vue';
import { useAuthStore } from '../stores/auth.js';
import PageHeader from '../design/primitives/PageHeader.vue';
import { useImportJob } from '../design/composables/useImportJob.js';
import { bulkJobTitle } from '../design/lib/bulkJob.js';
import { fmtAbsolute } from '../design/lib/format.js';

const props = defineProps<{ id: string }>();

function save({ fileName, csv }: BulkJobResultsDownload): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

const imp = useImportJob({ save });
const auth = useAuthStore();
const {
  classTap,
  job,
  rows,
  results,
  loading,
  loadError,
  failure,
  busy,
  resultsNote,
  reset,
  resetNote,
  needingReset,
  canReset,
  confirmingReset,
} = imp;

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

const TONE: Record<ImportJobRow['status'], string> = {
  pending: 'muted',
  running: 'blue',
  succeeded: 'green',
  partial: 'amber',
  failed: 'red',
  skipped: 'muted',
};
const accounts = (n: number) => (n === 1 ? '1 account' : `${n} accounts`);
const created = computed(() => rows.value.filter((r) => r.id !== null).length);

/** What went wrong for a row: each failed step, or why it wasn't created. */
const problemsOf = (row: ImportJobRow): string[] =>
  row.failed.length > 0
    ? row.failed.map((f) => f.message)
    : row.errorMessage && row.status !== 'succeeded'
      ? [row.errorMessage]
      : [];

const LICENSE_TONE: Record<ImportLicenseState, string> = {
  pending: 'muted',
  active: 'green',
  activeWithError: 'amber',
  disabled: 'muted',
  error: 'red',
};
const showLicenses = computed(() => rows.value.some((r) => r.licenses));

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
      <ImportJobTabs
        v-if="classTap && auth.hasCapability('write:user.issueTap')"
        :id="job.id"
        active="people"
        people
        roster
      />
      <ClassAlerts v-if="classTap" :alerts="classTap.alerts" />
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

      <section v-if="canReset || reset" class="ij-section" aria-labelledby="ij-reset">
        <h2 id="ij-reset" class="ij-title">Reset their passwords</h2>
        <template v-if="reset">
          <BulkJobPanel
            :job="reset.job"
            :busy="busy"
            @stop="imp.stopReset"
            @continue="imp.continueReset"
            @retry="imp.retryReset"
          />
          <p class="ij-note">{{ resetNote }}</p>
          <div class="ij-download">
            <Button
              label="Download new passwords"
              icon="pi pi-download"
              :loading="imp.downloading.value"
              :disabled="!imp.canDownloadReset.value"
              @click="imp.downloadReset"
            />
          </div>
        </template>
        <template v-if="canReset">
          <p v-if="!confirmingReset" class="ij-note">
            Give the {{ accounts(created) }} the import created new passwords, which they must
            change at sign-in, downloaded once as a CSV.
            <template v-if="needingReset.length">
              {{ needingReset.length }} of them nobody has the password of.</template
            >
          </p>
          <Button
            v-if="!confirmingReset"
            :label="reset ? 'Reset them again…' : 'Reset their passwords…'"
            icon="pi pi-key"
            severity="secondary"
            :disabled="busy"
            @click="imp.requestReset"
          />
          <Message v-else severity="warn" :closable="false" class="ij-msg">
            Reset the passwords of {{ accounts(created) }}? Whatever password they have now stops
            working.
            <span class="ij-confirm">
              <Button
                :label="`Reset ${accounts(created)}`"
                size="small"
                :disabled="busy"
                @click="imp.startReset"
              />
              <Button
                label="Cancel"
                size="small"
                text
                severity="secondary"
                @click="imp.cancelReset"
              />
            </span>
          </Message>
        </template>
      </section>

      <section class="ij-section" aria-labelledby="ij-rows">
        <h2 id="ij-rows" class="ij-title">People</h2>
        <p v-if="imp.licensesWaiting.value" class="ij-note">
          OpenADUC reads each person’s licenses from Microsoft Entra once they’ve synced, then again
          after a minute, two, four and eight, and every quarter of an hour after that, until each
          license is assigned or Entra says why not. It stops waiting a day after the import for
          sync, and two hours after sync for the licenses.
        </p>
        <div class="ij-table-wrap">
          <table class="ij-table">
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Name</th>
                <th scope="col">Username</th>
                <th scope="col">UPN</th>
                <th scope="col">Result</th>
                <th v-if="showLicenses" scope="col">Licenses</th>
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
                  <span class="badge" :class="`badge-${TONE[row.status]}`">
                    <span class="badge-dot" />{{ IMPORT_ROW_STATUS_LABEL[row.status] }}
                  </span>
                  <span v-if="row.needsPasswordReset" class="badge badge-amber ij-reset-badge">
                    Needs a password reset
                  </span>
                  <ul v-if="problemsOf(row).length" class="ij-problems">
                    <li v-for="(p, i) in problemsOf(row)" :key="i">{{ p }}</li>
                  </ul>
                </td>
                <td v-if="showLicenses">
                  <template v-if="row.licenses">
                    <ul class="ij-licenses">
                      <li v-for="l in row.licenses.licenses" :key="`${l.skuId}:${l.group}`">
                        <span class="ij-license-head">
                          <LicenseName :license="l" />
                          <span class="badge" :class="`badge-${LICENSE_TONE[l.state]}`">
                            <span class="badge-dot" />{{ IMPORT_LICENSE_STATE_LABEL[l.state] }}
                          </span>
                        </span>
                        <span class="hint">From {{ l.group }}</span>
                        <p v-if="licenseProblem(l)" class="ij-license-error">
                          {{ licenseProblem(l) }}
                        </p>
                      </li>
                    </ul>
                    <p v-if="row.licenses.message" class="ij-license-note">
                      {{ row.licenses.message }}
                    </p>
                  </template>
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

.ij-confirm {
  display: inline-flex;
  gap: 4px;
  margin-left: 8px;
}

.ij-reset-badge {
  margin-left: 6px;
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

.ij-licenses {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.ij-licenses li {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ij-license-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
}

.ij-license-error {
  margin: 0;
  color: var(--red);
}

.ij-license-note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-2);
}

.ij-problems {
  margin: 6px 0 0;
  padding-left: 16px;
  font-size: 12px;
  color: var(--text-2);
}
</style>
