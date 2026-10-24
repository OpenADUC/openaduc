<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Import users from a spreadsheet, in six steps. The workflow, its draft
  and its checks live in useUserImport; this renders them. Opened from the
  user list, or from an OU with ?ou=<dn>, which every bucket starts in.
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import Button from 'primevue/button';
import Message from 'primevue/message';
import PageHeader from '../design/primitives/PageHeader.vue';
import { IMPORT_STEP_LABEL, useUserImport } from '../design/composables/useUserImport.js';
import { IMPORT_STEPS } from '../design/lib/importDraft.js';
import { useAuthStore } from '../stores/auth.js';
import SourceStep from './userImport/SourceStep.vue';
import ColumnsStep from './userImport/ColumnsStep.vue';
import NamesStep from './userImport/NamesStep.vue';
import BucketsStep from './userImport/BucketsStep.vue';
import OptionsStep from './userImport/OptionsStep.vue';
import CheckStep from './userImport/CheckStep.vue';

const route = useRoute();
const auth = useAuthStore();
const wizard = useUserImport();
const { draft, stepIndex, canContinue, loading, loadError } = wizard;

const canImport = computed(() => auth.hasCapability('write:user.create'));
const STEP_VIEW = {
  source: SourceStep,
  columns: ColumnsStep,
  names: NamesStep,
  buckets: BucketsStep,
  options: OptionsStep,
  check: CheckStep,
};

onMounted(() => {
  const ou = typeof route.query.ou === 'string' && route.query.ou ? route.query.ou : null;
  if (canImport.value) void wizard.start(ou);
});
</script>

<template>
  <div class="page-inner import-page">
    <PageHeader title="Import users" sub="Create up to 500 people from a spreadsheet.">
      <template v-if="draft.table" #actions>
        <Button
          label="Start over"
          icon="pi pi-refresh"
          severity="secondary"
          outlined
          @click="wizard.startOver"
        />
      </template>
    </PageHeader>

    <Message v-if="!canImport" severity="warn" :closable="false">
      Importing users takes the write:user.create capability.
    </Message>
    <template v-else>
      <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>

      <ol class="im-steps" aria-label="Steps">
        <li
          v-for="(step, i) in IMPORT_STEPS"
          :key="step"
          :class="{ current: i === stepIndex, done: i < stepIndex }"
          :aria-current="i === stepIndex ? 'step' : undefined"
        >
          <button type="button" :disabled="i >= stepIndex" @click="wizard.goTo(step)">
            <span class="im-step-n">{{ i + 1 }}</span>
            <span>{{ IMPORT_STEP_LABEL[step] }}</span>
          </button>
        </li>
      </ol>

      <section class="im-body" :aria-busy="loading">
        <component :is="STEP_VIEW[draft.step]" :wizard="wizard" />
      </section>

      <footer class="im-foot">
        <Button
          v-if="stepIndex > 0"
          label="Back"
          icon="pi pi-arrow-left"
          severity="secondary"
          text
          @click="wizard.back"
        />
        <span class="im-spacer" />
        <Button
          v-if="draft.step !== 'check'"
          label="Next"
          icon="pi pi-arrow-right"
          icon-pos="right"
          :disabled="!canContinue || loading"
          @click="wizard.next"
        />
      </footer>
    </template>
  </div>
</template>

<style scoped>
.im-steps {
  list-style: none;
  margin: 8px 0 20px;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.im-steps button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.im-steps button:disabled {
  cursor: default;
}

.im-steps li.done button {
  color: var(--text-2);
}

.im-steps li.current button {
  border-color: var(--accent);
  color: var(--text);
  font-weight: 600;
}

.im-step-n {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--surface-2);
  font-size: 11px;
}

.im-steps li.current .im-step-n {
  background: var(--accent);
  color: var(--accent-contrast);
}

.im-body {
  max-width: 64rem;
}

.im-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 64rem;
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.im-spacer {
  flex: 1;
}

@media (max-width: 767.98px) {
  .im-steps .im-step-n + span {
    display: none;
  }

  .im-steps li.current .im-step-n + span {
    display: inline;
  }
}
</style>
