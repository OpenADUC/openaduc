<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Step 6: the final check, against the directory right before the run:
  each name still free, each OU, group and manager still there. Running
  the import starts its job and moves on to the job's results page.
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import Message from 'primevue/message';
import type { ImportCheckIssueKind } from '@openaduc/shared';
import type { useUserImport } from '../../design/composables/useUserImport.js';
import { fmtAbsolute } from '../../design/lib/format.js';

const props = defineProps<{ wizard: ReturnType<typeof useUserImport> }>();
const w = props.wizard;
const {
  importRequest,
  checking,
  checkError,
  result,
  checkStale,
  checkProblems,
  checkWarnings,
  protectedGroups,
  acknowledgedProtected,
  ready,
  running,
  runError,
  rulesError,
  startedJobId,
} = w;

const router = useRouter();
const openJob = () =>
  startedJobId.value &&
  router.push({ name: 'user-import-job', params: { id: startedJobId.value } });
// A placement rule that didn't save is said here first; the import runs regardless.
watch(startedJobId, (id) => {
  if (id && !rulesError.value) void openJob();
});

const count = computed(() => importRequest.value?.rows.length ?? 0);
const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);
const groupNames = computed(() => protectedGroups.value.map((g) => g.name).join(', '));
/** Where a problem is fixed: OUs and groups in Buckets, the rest in Review names. */
const fixIn = (kind: ImportCheckIssueKind) =>
  kind === 'ou_missing' || kind === 'group_missing' || kind === 'role_group'
    ? ('buckets' as const)
    : kind === 'password' || kind === 'class'
      ? ('options' as const)
      : ('names' as const);
const FIX_LABEL = { names: 'Review names', buckets: 'Buckets', options: 'Options' };
</script>

<template>
  <div class="ck">
    <p class="ck-intro">
      {{ people(count) }} to create. The final check asks the directory again whether each name is
      still free and each OU, group and manager still there. It changes nothing.
    </p>
    <Message v-if="!importRequest" severity="warn" :closable="false" class="ck-msg">
      Some rows need another look before the check.
      <Button label="Review names" size="small" text @click="w.goTo('names')" />
    </Message>
    <Button
      :label="result || checkStale ? 'Check again' : 'Run the final check'"
      icon="pi pi-shield"
      :loading="checking"
      :disabled="!importRequest"
      @click="w.runCheck"
    />
    <Message v-if="checkError" severity="error" :closable="false" class="ck-msg">
      {{ checkError }}
    </Message>

    <template v-if="result || checkStale">
      <p class="hint ck-when">
        <template v-if="checkStale">You’ve changed the import since the last check. </template>
        <template v-else-if="result">Checked {{ fmtAbsolute(result.checkedAt) }}</template>
      </p>
      <section v-if="checkProblems.length" class="ck-section">
        <h3 class="ck-title ck-bad">Changed since the review ({{ checkProblems.length }})</h3>
        <p class="ck-note">The review has asked the directory again, so they show there too.</p>
        <ul class="ck-list">
          <li v-for="(p, i) in checkProblems" :key="i">
            <span v-if="p.line" class="ck-line">Row {{ p.line }} · {{ p.name }}</span>
            {{ p.message }}
            <span class="ck-actions">
              <Button
                :label="FIX_LABEL[fixIn(p.kind)]"
                size="small"
                text
                @click="w.goTo(fixIn(p.kind))"
              />
              <Button
                v-if="p.row !== null"
                label="Leave out"
                size="small"
                text
                severity="secondary"
                :aria-label="`Leave row ${p.line} out`"
                @click="w.exclude(p.row)"
              />
            </span>
          </li>
        </ul>
      </section>
      <section v-if="checkWarnings.length" class="ck-section">
        <h3 class="ck-title ck-warn">Worth a look ({{ checkWarnings.length }})</h3>
        <ul class="ck-list">
          <li v-for="(p, i) in checkWarnings" :key="i">
            <span v-if="p.line" class="ck-line">Row {{ p.line }} · {{ p.name }}</span>
            {{ p.message }}
          </li>
        </ul>
      </section>
      <template v-if="result && !checkProblems.length">
        <label v-if="protectedGroups.length" class="ck-ack">
          <input v-model="acknowledgedProtected" type="checkbox" />
          <span>I understand these users gain admin rights in AD through {{ groupNames }}.</span>
        </label>
        <p class="ck-ok">
          <i class="pi pi-check-circle" aria-hidden="true" /> Ready to import {{ people(count) }}.
        </p>
      </template>
    </template>

    <div class="ck-run">
      <Button
        :label="`Import ${people(count)}`"
        icon="pi pi-play"
        :loading="running"
        :disabled="!ready || !!startedJobId"
        @click="w.run"
      />
      <span v-if="!ready" class="hint">Run the final check first.</span>
      <span v-else class="hint">
        It runs on the server: you can leave the page and come back to its results.
      </span>
    </div>
    <Message v-if="runError" severity="error" :closable="false" class="ck-msg">
      {{ runError }}
    </Message>
    <Message v-if="startedJobId && rulesError" severity="warn" :closable="false" class="ck-msg">
      The import is running, but its placement rules weren’t saved: {{ rulesError }}
      <Button label="See its progress" size="small" text @click="openJob" />
    </Message>
  </div>
</template>

<style scoped>
.ck-intro {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-2);
}

.ck-when {
  margin: 8px 0;
}

.ck-section {
  margin: 12px 0;
}

.ck-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.ck-bad {
  color: var(--red);
}

.ck-warn {
  color: var(--amber);
}

.ck-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--text-2);
}

.ck-line {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-3);
  margin-right: 4px;
}

.ck-actions {
  white-space: nowrap;
}

.ck-note {
  font-size: 12px;
  color: var(--text-3);
}

.ck-ack {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 0;
  font-size: 13px;
  color: var(--text-2);
}

.ck-ok {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--green);
}

.ck-run {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.ck-msg {
  margin: 8px 0;
}
</style>
