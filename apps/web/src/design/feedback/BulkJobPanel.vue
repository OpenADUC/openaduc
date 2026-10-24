<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import Message from 'primevue/message';
import Button from 'primevue/button';
import ProgressBar from 'primevue/progressbar';
import type { BulkJob } from '@openaduc/shared';
import { describeBulkJob, type BulkJobControl } from '../lib/bulkJob.js';

// A bulk job's progress or result, with what the operator can do next.
const props = defineProps<{ job: BulkJob; failure?: string | null; busy?: boolean }>();
const emit = defineEmits<(e: BulkJobControl) => void>();

const description = computed(() => describeBulkJob(props.job));

const CONTROLS: Record<
  BulkJobControl,
  { label: string; icon: string; severity?: 'secondary'; text?: boolean }
> = {
  stop: { label: 'Stop', icon: 'pi pi-stop-circle', severity: 'secondary', text: true },
  continue: { label: 'Continue', icon: 'pi pi-play' },
  retry: { label: 'Retry failed', icon: 'pi pi-refresh' },
  revert: { label: 'Revert…', icon: 'pi pi-undo', severity: 'secondary', text: true },
  dismiss: { label: 'Dismiss', icon: 'pi pi-times', severity: 'secondary', text: true },
};
</script>

<template>
  <Message :severity="description.tone" :closable="false" class="bulk-job" role="status">
    <div class="bulk-job-body">
      <div class="bulk-job-text">
        <strong class="bulk-job-title">{{ description.title }}</strong>
        <div v-if="description.detail" class="bulk-job-detail">{{ description.detail }}</div>
        <div v-if="failure" class="bulk-job-failure" role="alert">{{ failure }}</div>
        <ProgressBar
          v-if="description.progress !== null"
          :value="description.progress"
          :show-value="false"
          class="bulk-job-progress"
        />
      </div>
      <div class="bulk-job-controls">
        <Button
          v-for="control in description.controls"
          :key="control"
          :label="CONTROLS[control].label"
          :icon="CONTROLS[control].icon"
          :severity="CONTROLS[control].severity"
          :text="CONTROLS[control].text"
          size="small"
          :disabled="busy"
          @click="emit(control)"
        />
      </div>
    </div>
  </Message>
</template>

<style scoped>
/* In a page that fills the viewport, the panel keeps its height. */
.bulk-job {
  flex-shrink: 0;
}

.bulk-job-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.bulk-job-text {
  flex: 1 1 16rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bulk-job-detail,
.bulk-job-failure {
  font-size: 12.5px;
}

.bulk-job-failure {
  color: var(--red);
}

.bulk-job-progress {
  height: 6px;
  max-width: 420px;
}

.bulk-job-controls {
  display: flex;
  gap: 4px;
}
</style>
