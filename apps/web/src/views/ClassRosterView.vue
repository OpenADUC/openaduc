<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  An import's class roster: each person, their contact details, and their
  Temporary Access Pass, to reveal or copy, reissue, or make again for a
  rescheduled class. The workflow lives in useClassRoster; this renders it.
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import {
  CLASS_PASS_STATUS_LABEL,
  lifetimeLabel,
  type ClassPassStatus,
  type ClassRosterRow,
} from '@openaduc/shared';
import PageHeader from '../design/primitives/PageHeader.vue';
import { useClassRoster } from '../design/composables/useClassRoster.js';
import { fmtAbsolute } from '../design/lib/format.js';
import ClassAlerts from './importJob/ClassAlerts.vue';
import ImportJobTabs from './importJob/ImportJobTabs.vue';

const props = defineProps<{ id: string }>();

const r = useClassRoster();
const {
  roster,
  rows,
  loading,
  loadError,
  revealed,
  rowNotes,
  busyRow,
  confirmingReissue,
  rescheduling,
  rescheduleBusy,
  rescheduleError,
  newDate,
  newTime,
  byStartDate,
  rescheduled,
} = r;

watch(
  () => props.id,
  (id) => void r.open(id),
  { immediate: true },
);

const TONE: Record<ClassPassStatus, string> = {
  awaitingAccount: 'muted',
  notCreated: 'red',
  waitingForSync: 'amber',
  retrying: 'amber',
  scheduled: 'muted',
  paused: 'amber',
  otherPass: 'amber',
  refused: 'red',
  failed: 'red',
  notYetValid: 'blue',
  usable: 'green',
  used: 'muted',
  expired: 'muted',
  replaced: 'amber',
  issued: 'blue',
};

const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);

/** When Connect Sync last ran: the time alone if it was today. */
const lastCycle = computed(() => {
  const at = roster.value?.lastSyncAt;
  if (!at) return null;
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : fmtAbsolute(date);
});

const statusLabel = (row: ClassRosterRow) =>
  row.status === 'waitingForSync' && lastCycle.value
    ? `Waiting for sync, last cycle ${lastCycle.value}`
    : CLASS_PASS_STATUS_LABEL[row.status];

const schedule = computed(() => {
  const c = roster.value?.class;
  if (!c) return '';
  const when =
    c.start.kind === 'fixed'
      ? `Class starts ${fmtAbsolute(c.start.startsAt)}`
      : `Class starts on each person’s start date at ${c.start.time} (${c.start.timeZone})`;
  const use = c.isUsableOnce ? 'single-use' : 'multi-use';
  const by = roster.value?.authoriser.name
    ? `, made on ${roster.value.authoriser.name}’s authority`
    : '';
  return `${when}. Passes last ${lifetimeLabel(c.lifetimeMinutes)}, ${use}${by}.`;
});

const title = computed(() => {
  const job = roster.value?.job;
  return job?.actorDisplayName
    ? `Class roster · import by ${job.actorDisplayName}`
    : 'Class roster';
});
</script>

<template>
  <div class="page-inner cr-page">
    <PageHeader
      :title="title"
      :sub="roster ? `Import started ${fmtAbsolute(roster.job.createdAt)}` : ''"
    >
      <template #actions>
        <Button
          label="Refresh"
          icon="pi pi-refresh"
          size="small"
          severity="secondary"
          text
          :loading="loading"
          @click="r.refresh"
        />
      </template>
    </PageHeader>

    <ImportJobTabs :id="id" active="roster" :people="!!roster?.job.own" roster />

    <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>
    <p v-else-if="loading && !roster" class="hint">Loading…</p>

    <template v-if="roster">
      <ClassAlerts
        :alerts="roster.alerts"
        can-take-over
        :taking-over="r.takingOver.value"
        @take-over="r.takeOver"
      />
      <Message v-if="r.takeOverError.value" severity="error" :closable="false" class="cr-msg">
        {{ r.takeOverError.value }}
      </Message>
      <Message v-if="roster.statusError" severity="info" :closable="false" class="cr-msg">
        {{ roster.statusError }}
      </Message>

      <section class="cr-section" aria-labelledby="cr-class">
        <h2 id="cr-class" class="cr-title">Class</h2>
        <p class="cr-note">
          {{ schedule }} A pass can’t be used before class starts. OpenADUC keeps each one until it
          expires; every reveal is recorded in the audit log.
        </p>
        <div v-if="!rescheduling">
          <Button
            label="Reschedule class…"
            icon="pi pi-calendar"
            size="small"
            severity="secondary"
            @click="r.startReschedule"
          />
        </div>
        <div v-else class="cr-reschedule">
          <div class="cr-when">
            <InputText
              v-if="!byStartDate"
              v-model="newDate"
              type="date"
              aria-label="New class date"
              :disabled="rescheduleBusy"
            />
            <span v-else class="cr-at">Each person’s start date at</span>
            <InputText
              v-model="newTime"
              type="time"
              aria-label="New class start time"
              :disabled="rescheduleBusy"
            />
            <span class="cr-at">{{ r.timeZone.value }}</span>
          </div>
          <Message severity="warn" :closable="false" class="cr-msg">
            Every pass is made again for the new start, the ones they hold deleted first: passes
            already handed out stop working. Rescheduling makes you the one the passes are made for.
            <span class="cr-confirm">
              <Button
                label="Reschedule"
                size="small"
                :loading="rescheduleBusy"
                :disabled="!r.newStart.value"
                @click="r.reschedule"
              />
              <Button
                label="Cancel"
                size="small"
                text
                severity="secondary"
                :disabled="rescheduleBusy"
                @click="r.cancelReschedule"
              />
            </span>
          </Message>
          <Message v-if="rescheduleError" severity="error" :closable="false" class="cr-msg">
            {{ rescheduleError }}
          </Message>
        </div>
        <Message
          v-if="rescheduled?.skipped.length"
          severity="info"
          :closable="false"
          class="cr-msg"
        >
          Rescheduled {{ people(rescheduled.rescheduled) }}. Left as they were:
          <ul class="cr-skipped">
            <li v-for="s in rescheduled.skipped" :key="s.rowId">
              Row {{ s.line }} ({{ s.displayName }}): {{ s.message }}
            </li>
          </ul>
        </Message>
      </section>

      <section class="cr-section" aria-labelledby="cr-people">
        <h2 id="cr-people" class="cr-title">{{ people(rows.length) }}</h2>
        <div class="cr-table-wrap">
          <table class="cr-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Username</th>
                <th scope="col">Personal email</th>
                <th scope="col">Mobile</th>
                <th scope="col">TAP status</th>
                <th scope="col">TAP</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.rowId">
                <td>
                  <RouterLink v-if="row.id" :to="{ name: 'user-detail', params: { id: row.id } }">
                    {{ row.displayName }}
                  </RouterLink>
                  <span v-else>{{ row.displayName }}</span>
                </td>
                <td class="mono">{{ row.samAccountName }}</td>
                <td>{{ row.personalEmail ?? '—' }}</td>
                <td class="mono">{{ row.mobile ?? '—' }}</td>
                <td>
                  <span class="badge" :class="`badge-${TONE[row.status]}`">
                    <span class="badge-dot" />{{ statusLabel(row) }}
                  </span>
                  <p v-if="row.startsAt" class="cr-detail">
                    {{ fmtAbsolute(row.startsAt) }} to {{ fmtAbsolute(row.expiresAt) }}
                  </p>
                  <p v-if="row.message" class="cr-detail">{{ row.message }}</p>
                </td>
                <td class="cr-pass">
                  <div class="cr-pass-row">
                    <code v-if="revealed[row.rowId]" class="cr-value" data-testid="class-pass">{{
                      revealed[row.rowId]!.temporaryAccessPass
                    }}</code>
                    <span v-else-if="row.held" class="cr-hidden" aria-label="Hidden">••••••••</span>
                    <template v-if="row.held || revealed[row.rowId]">
                      <Button
                        v-if="revealed[row.rowId]"
                        label="Hide"
                        size="small"
                        text
                        severity="secondary"
                        @click="r.hide(row.rowId)"
                      />
                      <Button
                        v-else
                        label="Reveal"
                        icon="pi pi-eye"
                        size="small"
                        text
                        :loading="busyRow === row.rowId"
                        @click="r.reveal(row.rowId)"
                      />
                      <Button
                        label="Copy"
                        icon="pi pi-copy"
                        size="small"
                        text
                        severity="secondary"
                        :disabled="busyRow === row.rowId"
                        @click="r.copy(row.rowId)"
                      />
                    </template>
                    <Button
                      v-if="r.reissuable(row) && confirmingReissue !== row.rowId"
                      label="Reissue…"
                      size="small"
                      text
                      severity="secondary"
                      :disabled="busyRow === row.rowId"
                      @click="r.requestReissue(row.rowId)"
                    />
                  </div>
                  <div v-if="confirmingReissue === row.rowId" class="cr-reissue">
                    <span>
                      Make {{ row.displayName }} a new pass? The one they have stops working.
                    </span>
                    <Button label="Reissue" size="small" @click="r.reissue" />
                    <Button
                      label="Cancel"
                      size="small"
                      text
                      severity="secondary"
                      @click="r.cancelReissue"
                    />
                  </div>
                  <p
                    v-if="rowNotes[row.rowId]"
                    class="cr-detail"
                    :class="`cr-note-${rowNotes[row.rowId]!.tone}`"
                  >
                    {{ rowNotes[row.rowId]!.text }}
                  </p>
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
.cr-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 80rem;
}

.cr-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cr-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.cr-note {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
}

.cr-msg {
  margin: 0;
}

.cr-reschedule {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cr-when {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.cr-at {
  font-size: 12px;
  color: var(--text-3);
}

.cr-confirm {
  display: inline-flex;
  gap: 4px;
  margin-left: 8px;
}

.cr-table-wrap {
  overflow-x: auto;
}

.cr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.cr-table th {
  text-align: left;
  font-weight: 600;
  color: var(--text-3);
  font-size: 12px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.cr-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.cr-table .mono,
.cr-value {
  font-family: var(--font-mono);
  font-size: 12px;
}

.cr-pass-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}

.cr-value {
  user-select: all;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--surface-2);
}

.cr-hidden {
  color: var(--text-3);
  letter-spacing: 1px;
}

.cr-reissue {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 12px;
}

.cr-detail {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-2);
}

.cr-skipped {
  margin: 4px 0 0;
  padding-left: 16px;
}

.cr-note-warn {
  color: var(--amber);
}

.cr-note-error {
  color: var(--red);
}
</style>
