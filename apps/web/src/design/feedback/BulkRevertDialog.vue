<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Revert a bulk job: whom it puts back and what, who has changed since the
  job (ticked to revert them anyway), and whom it can't revert, then
  confirm with the count. Renders a useBulkJobRevert the page owns;
  confirming starts the revert's job.
-->
<script setup lang="ts">
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Message from 'primevue/message';
import type { BulkRevertChange } from '@openaduc/shared';
import {
  revertChangeLabel,
  revertValueText,
  type useBulkJobRevert,
} from '../composables/useBulkJobRevert.js';

const props = defineProps<{ workflow: ReturnType<typeof useBulkJobRevert> }>();

const {
  visible,
  entry,
  preview,
  previewing,
  previewError,
  includeAll,
  canConfirm,
  confirmLabel,
  caveat,
} = props.workflow;
const w = props.workflow;

const value = (c: BulkRevertChange, v: string | boolean | null) => revertValueText(c.field, v);
const listed = (shown: number, total: number) =>
  total > shown ? `The first ${shown} are listed; ${total - shown} more aren’t.` : null;
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Revert bulk job"
    :style="{ width: '38rem' }"
    @update:visible="(v) => !v && w.close()"
  >
    <p v-if="entry" class="br-entry">{{ entry.title }}</p>
    <div v-if="previewing" class="hint">Working out what it would put back…</div>
    <Message v-else-if="previewError" severity="error" :closable="false">
      Couldn’t work out what it would put back: {{ previewError }}
    </Message>

    <template v-else-if="preview">
      <p class="br-summary">
        {{
          preview.revert.count === 1
            ? 'Puts back what the job changed for 1 account.'
            : `Puts back what the job changed for ${preview.revert.count} accounts.`
        }}
      </p>
      <Message v-if="caveat" severity="warn" :closable="false" class="br-warning">
        {{ caveat }}
      </Message>

      <ul v-if="preview.revert.users.length > 0" class="br-users" aria-label="Accounts it reverts">
        <li v-for="u in preview.revert.users" :key="u.id" class="br-user">
          <span>{{ u.name }}</span>
          <span v-for="(c, i) in u.changes" :key="i" class="br-change">
            {{ revertChangeLabel(c) }}: {{ value(c, c.job) }} → {{ value(c, c.restore) }}
          </span>
        </li>
      </ul>
      <p v-if="listed(preview.revert.users.length, preview.revert.count)" class="br-note">
        {{ listed(preview.revert.users.length, preview.revert.count) }}
      </p>

      <section v-if="preview.modified.count > 0" class="br-modified" aria-label="Changed since">
        <p class="br-heading">
          Changed again since the job ({{ preview.modified.count }}): left as they are unless you
          tick them.
        </p>
        <label class="br-choice">
          <input
            type="checkbox"
            :checked="includeAll"
            @change="w.setIncludeAll(($event.target as HTMLInputElement).checked)"
          />
          <span>Revert all {{ preview.modified.count }} anyway</span>
        </label>
        <ul class="br-users">
          <li v-for="u in preview.modified.users" :key="u.id" class="br-user">
            <label class="br-choice">
              <input
                type="checkbox"
                :checked="w.isIncluded(u.id)"
                :disabled="includeAll"
                @change="w.toggle(u.id)"
              />
              <span>{{ u.name }}</span>
            </label>
            <span v-for="(c, i) in u.changes" :key="i" class="br-change">
              {{ revertChangeLabel(c) }}: now {{ value(c, c.now) }} (the job set
              {{ value(c, c.job) }}); reverting sets {{ value(c, c.restore) }}
            </span>
          </li>
        </ul>
        <p v-if="listed(preview.modified.users.length, preview.modified.count)" class="br-note">
          {{ listed(preview.modified.users.length, preview.modified.count) }}
        </p>
      </section>

      <details v-if="preview.notRevertible.count > 0" class="br-details" open>
        <summary>Can’t be reverted ({{ preview.notRevertible.count }})</summary>
        <ul>
          <li v-for="u in preview.notRevertible.users" :key="u.id">{{ u.name }}: {{ u.reason }}</li>
        </ul>
      </details>
      <details v-if="preview.unchanged.count > 0" class="br-details">
        <summary>Already as before the job ({{ preview.unchanged.count }})</summary>
        <ul>
          <li v-for="u in preview.unchanged.users" :key="u.id">{{ u.name }}</li>
        </ul>
      </details>
      <p v-if="preview.excluded > 0" class="br-note">
        {{
          preview.excluded === 1
            ? '1 row of the job failed or needed no change, so there’s nothing to put back for it.'
            : `${preview.excluded} rows of the job failed or needed no change, so there’s nothing to put back for them.`
        }}
      </p>
      <Message v-if="!canConfirm" severity="info" :closable="false">
        There’s nothing to revert.
      </Message>
    </template>

    <template #footer>
      <Button label="Cancel" severity="secondary" text @click="w.close" />
      <Button
        :label="confirmLabel"
        icon="pi pi-undo"
        :disabled="!preview || !canConfirm"
        @click="w.confirm"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.br-entry {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-2);
}

.br-summary,
.br-heading {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.br-heading {
  margin-top: 12px;
}

.br-note {
  margin: 4px 0 8px;
  font-size: 12.5px;
  color: var(--text-2);
}

.br-warning {
  margin: 0 0 8px;
}

.br-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.br-users {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  max-height: 14rem;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.br-user {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.br-user:last-child {
  border-bottom: 0;
}

.br-change {
  font-size: 12px;
  color: var(--text-3);
}

.br-details {
  margin-top: 10px;
  font-size: 12.5px;
}

.br-details summary {
  cursor: pointer;
  color: var(--text-2);
}

.br-details ul {
  margin: 6px 0 0;
  padding-left: 18px;
  max-height: 10rem;
  overflow-y: auto;
}
</style>
